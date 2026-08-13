# Sandbox spike findings (Gate 2)

Empirical results from `scripts/spike-sandbox.ts` and ad-hoc follow-up spikes,
run against `@anthropic-ai/claude-agent-sdk@0.3.223` on this machine
(bubblewrap + socat installed, user namespaces enabled).

## Confirmed working as expected

- **`failIfUnavailable: true` fails closed.** With `socat` missing, `query()`
  threw immediately with `Sandbox required but unavailable: ... socat not
  installed` instead of silently running unsandboxed. This is the behavior
  the whole design depends on.
- **External network is blocked** with `strictAllowlist: true` and an empty
  `allowedDomains` — `curl https://example.com` gets `HTTP_STATUS:000`
  (connection never established), not a permission prompt, not a soft
  failure.
- **Filesystem containment works**, but only for paths that exist on the
  **host** before the sandboxed process starts — bubblewrap bind-mounts
  existing directories, it can't materialize a new writable directory the
  agent tries to `mkdir` under an already-read-only mount. This matches (and
  validates) the real orchestration flow: the harness creates the worktree
  and scratch directories before calling `query()`, never after.

## Important deviation from the original design assumption

**Each `Bash` tool call gets its own network namespace.** Loopback
connectivity works fine *within* a single call (`server & sleep 1 && curl`
in one command succeeds, `HTTP_STATUS:200`), but a server backgrounded in
one `Bash` call is **unreachable from a later, separate `Bash` call** — even
with `localhost`/`127.0.0.1` explicitly listed in `allowedDomains`. This
isn't a domain-allowlist problem; it's `127.0.0.1` inside one call's sandbox
instance pointing at a different loopback interface than the one a
previous call's server bound to. `allowLocalBinding` does not create a
cross-call exception for this — it's undocumented precisely enough to
confirm what it *does* do, but it does not do this.

This directly hits the "start a dev server, then use it later" pattern —
exactly the shape of the explicitly-requested Playwright/dev-server/
container capability, since starting something in the background and acting
on it afterward is inherently two separate tool calls.

## Resulting design decision

Bash-tokenized commands matching the `dev-servers`, `playwright`, or
`containers` filter categories (`config/rules/50-dev-servers.json`,
`60-playwright.json`, `70-containers.json`) are allowed by the harness
filter with `updatedInput.dangerouslyDisableSandbox: true` injected by the
**filter engine itself** — never because the model asked for it. The hard
deny rule in `00-hard-deny.json` for `dangerouslyDisableSandbox` only fires
on the *model's own* tool-call input before the filter runs; it does not
see (and is not tricked by) the flag the engine adds afterward, because the
hard-deny check happens first, against the original unmodified input.

For this category, the kernel sandbox is not the enforcement boundary —
the harness-level filter (command allow-list, path containment via
`path-guard.ts`, and best-effort network-target parsing via
`network-guard.ts`) is the only gate. This is a real, narrower guarantee
than the rest of the command surface gets, and it's inherent to the tool's
actual behavior, not a shortcut. Two things partially mitigate it:

1. Everything else (read-only commands, git, build/test, linting, package
   installs — anything that's naturally one self-contained command) keeps
   full kernel+filter double enforcement, since those never need a
   background server from an earlier call.
2. `70-containers.json` additionally hard-denies dangerous `docker run`
   flags (`--privileged`, root-mounting `-v /:...`, `--network=host` etc.)
   at the argv level, since a container's own internal network egress is
   not visible to any regex-level filter once it's running — that gap is
   real and is not closed by anything short of Docker-level network
   policy (e.g. `--network none` / a custom bridge with no external route),
   which is out of scope for this pass and left as a documented follow-up.

## Correction: the `dangerouslyDisableSandbox` injection never took effect

The design decision above was written down but never actually ran.
`implementer.ts` passes `allowUnsandboxedCommands: false`, and the SDK
documents that setting as making the `dangerouslyDisableSandbox` parameter
"completely ignored", with all commands forced to run sandboxed. So the
flag `hooks.ts` injects for the `dev-servers`/`playwright`/`containers`
categories has always been silently dropped, and those commands have been
running *inside* the sandbox the whole time.

For containers this was the entire reason `docker` appeared broken, and
the fix turned out not to need unsandboxing at all — see below. For
dev-servers and playwright the cross-call loopback limitation above is
still open and still unmitigated; `allowUnsandboxedCommands` was
deliberately left at `false` rather than flipped, since flipping it would
drop three whole categories out of kernel enforcement at once. Treat the
`sandboxOverride: true` entries in those rule files as expressing intent,
not current behavior.

## `docker` does work inside the sandbox — the blocker is the Unix socket

The earlier claim that "`docker` is incompatible with the sandbox" was
wrong, or at least not the operative reason. `docker` and `podman` are thin
clients; everything they do is an HTTP request over
`/var/run/docker.sock`, and the sandbox blocks `AF_UNIX` `connect()` by
default. Measured directly against `claude -p --settings ...` with the same
sandbox config `implementer.ts` builds:

- baseline → `permission denied while trying to connect to the docker API
  at unix:///var/run/docker.sock`
- `network.allowAllUnixSockets: true` → `docker ps` succeeds, fully
  sandboxed, with `strictAllowlist` and the filesystem policy still on

Adding the socket path to `filesystem.allowWrite` was tested separately and
is **not** required — the block is seccomp, not the filesystem layer.

There is no docker-only version of this on Linux. `network.allowUnixSockets`
(the path-scoped list) is macOS-only precisely because seccomp cannot filter
sockets by path, so `allowAllUnixSockets` is the only lever and it un-blocks
every Unix socket for that run.

### What the grant actually costs

Reaching the docker daemon is equivalent to root on the host, and it
bypasses *both* remaining enforcement layers rather than just the kernel one:

- **Filesystem containment.** `docker run -v /home/you:/mnt` gives write
  access to anything the daemon can see. `70-containers.json` hard-denies
  only root-level mounts (`-v /:...`); any other host path is not covered,
  and `path-guard.ts` never sees inside the container.
- **Network containment.** A container gets its own network namespace with
  unrestricted egress. `allowedDomains`/`strictAllowlist` and
  `network-guard.ts` are both blind to it.

So this is strictly wider than the gap already documented in point 2 above.
It is therefore **per-project and off by default** — `allowDockerSocket` in
`config/projects.json`, persisted as `projects.allow_docker_socket`
(migration `005`), read by `implementer.ts` when it builds `sandbox.network`.

Two deliberate choices about how the grant is administered:

1. It is **not** exposed on `POST /api/projects`. Enabling it requires write
   access to the operator's `config/projects.json`, not just an
   authenticated session — a root-equivalent privilege should not be one
   API call away from anyone who can log into the web UI.
2. The seed upsert writes the column on every conflict, so deleting the
   line from `projects.json` **revokes** the grant on next boot rather than
   leaving a stale `1` behind.

The follow-up named in point 2 above (Docker-level network policy — a
`--network none` default or a custom bridge with no external route) is now
the main thing that would narrow this, and is still open.

## Host-local services: why test commands could not run at all

The symptom: an implementation run could not execute the project's test
suite, because every test that talks to a locally-running service (a
`supabase start` stack, a dev database, a compose service) failed to
connect. This looked like a docker restriction and is not one.

Measured inside a sandboxed `Bash` call, with the same sandbox config
`implementer.ts` builds:

```
$ ip -4 addr        -> lo only
$ ip route          -> (empty)
$ env | grep -i proxy
HTTP_PROXY=http://…@localhost:3128     # socat-forwarded to a proxy on the host
FTP_PROXY=socks5h://…@localhost:1080
NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

So the namespace has **no route to anything**; every packet that leaves does
so through the runtime's proxies, and `NO_PROXY` excludes loopback and the
whole private address space from that proxying. A connection to
`127.0.0.1:54321` is therefore attempted directly, inside a namespace where
nothing is listening, and fails — `Connection refused` for loopback,
`Network is unreachable` for `172.17.0.1`. Adding those addresses to
`allowedDomains` changes nothing, because `NO_PROXY` is consulted long
before the allowlist is.

The proxy itself is willing, and still enforces the allowlist:

| request from inside the sandbox | result |
| --- | --- |
| `curl http://127.0.0.1:54321/` (default env) | `000` — direct, no route |
| `curl --noproxy "" --proxy $HTTP_PROXY http://127.0.0.1:54321/` | **200** |
| same, host **not** in `allowedDomains` | **403** |
| `curl --noproxy "" --proxy $HTTP_PROXY http://example.com/` (not allowed) | 403 |

`NO_PROXY` cannot be changed from the parent process — the runtime
overwrites whatever `Options.env` sets, verified directly. The only place it
can be changed is the command itself.

### Fix 1: proxy routing for declared local hosts (kernel sandbox stays on)

`localServiceHosts` in `config/projects.json` (column `local_service_hosts`,
migration `006`) lists the hosts a project's dev services listen on. For
those projects the filter engine prefixes every allowed `Bash` command with

```sh
export NO_PROXY='<default minus the entries covering those hosts>' \
       no_proxy='…' NODE_USE_ENV_PROXY=1;
```

so exactly those hosts route through the proxy and everything else keeps its
default behavior (`src/filter/proxy-env.ts`). The hosts are merged into the
run's `allowedDomains`, since the proxy 403s an undeclared target either way.
Human-approved commands get the same prefix on the way out of `canUseTool`,
applied *after* the decision so the approval dialog shows the command the
agent actually wrote.

Verified end to end against a real `supabase start` stack, from inside a
fully sandboxed call: `curl http://127.0.0.1:54321/rest/v1/` → **200**, a
non-declared private host → still unreachable, and `node -e 'fetch(...)'` →
**200** on Node 24.

Two limits, both inherent:

- **Only proxy-aware clients.** curl, git and the package managers honor the
  env; Node's undici ignores it below Node 24 (`NODE_USE_ENV_PROXY`, which
  the prefix sets, is what makes 24+ work). `psql` and other raw-TCP clients
  never will — the SOCKS proxy requires username/password auth that `socat`'s
  `SOCKS5` address cannot negotiate, so even a hand-rolled forwarder inside
  the call does not close this.
- **Loopback semantics change for that project.** Once `127.0.0.1` is
  proxied, a server a command starts on loopback *within its own call* is no
  longer what a later connection in that same call reaches. That is why this
  is per-project and empty by default rather than global.

### Fix 2: `allowUnsandboxedCommands` (the escape hatch)

`allowUnsandboxedCommands` in `config/projects.json` (column
`allow_unsandboxed_commands`, migration `006`) flips the SDK setting that had
been hardcoded to `false` — the setting whose absence is why the
`dangerouslyDisableSandbox` injection described earlier in this document
never took effect. With it on, the engine's `sandboxOverride` rules become
real for that project, and `config/rules/30-build-test.json` and
`40-package-managers.json` now carry that flag (the latter because
`pnpm test` is how most projects invoke their runner — overriding build-test
alone would leave the hatch unreachable).

Verified: with the flag on, a `dangerouslyDisableSandbox` call reaches raw
postgres on `127.0.0.1:54322` and Kong on `:54321`.

What it costs, stated plainly: for that project, build/test, package-manager,
dev-server, playwright and container commands run with the harness filter
(argv allow-list, `path-guard.ts`, `network-guard.ts`) as the **only**
boundary. That filter cannot see inside `pytest`, `node -e`, or a compiled
test binary. It is the only option for a project whose tests speak raw TCP or
run on Node < 24, and it is off by default. Like `allowDockerSocket`, it is
settable only from the operator's `config/projects.json` and never through
`POST /api/projects`, and re-seeding revokes it when the line is removed.

### Consequence for the earlier "sandboxOverride is inert" correction

That correction stands for any project that has not opted in, and the hook
now enforces it: `dangerouslyDisableSandbox` is injected **only** when the
project sets `allowUnsandboxedCommands`. Previously it was injected
unconditionally and silently dropped by the SDK, which meant the
`tool_events` audit trail recorded commands as unsandboxed that had in fact
run inside the sandbox.
