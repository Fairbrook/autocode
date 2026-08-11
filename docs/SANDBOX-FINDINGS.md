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
on it afterward is inherently two separate tool calls. Separately, the
docs state plainly that **`docker` is incompatible with the sandbox** and
must be run via `excludedCommands`/unsandboxed regardless of network
namespacing.

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
