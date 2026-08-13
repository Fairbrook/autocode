-- Two per-project levers for the same problem: a sandboxed Bash call gets a
-- network namespace with only `lo` and no routes, so a test that talks to a
-- host-local service (dev database, `supabase start` stack, compose service)
-- cannot connect to it at all. See docs/SANDBOX-FINDINGS.md for the measured
-- behavior behind both columns.

-- Hosts whose traffic should be routed through the sandbox runtime's proxy
-- instead of being attempted directly. JSON string[] of hostnames/IPs, e.g.
-- ["127.0.0.1"]. The harness subtracts the matching entries from the NO_PROXY
-- the runtime exports, which is the only reason those connections fail: the
-- proxy itself will happily connect to a host-local port, and still refuses
-- (403) any host that isn't in the run's allowedDomains. Listed hosts are
-- therefore merged into allowedDomains automatically — routing a host to the
-- proxy without declaring it would just turn one failure mode into another.
--
-- This does not widen the network policy, but it does change loopback
-- semantics for the project's runs: once 127.0.0.1 is proxied, a server a
-- command starts on loopback *inside its own sandbox call* is no longer what
-- a later connection in that same call reaches. Hence per-project and empty
-- by default rather than global.
ALTER TABLE projects ADD COLUMN local_service_hosts TEXT NOT NULL DEFAULT '[]';

-- Lets the filter engine's `sandboxOverride` rules actually take effect for
-- this project: the SDK ignores `dangerouslyDisableSandbox` outright unless
-- `allowUnsandboxedCommands` is true, which is why the flag hooks.ts has been
-- injecting for dev-servers/playwright/containers has never done anything.
--
-- Turning it on drops every sandboxOverride category — build/test commands,
-- dev servers, playwright, containers — out of kernel enforcement for this
-- project, leaving the harness filter (argv allow-list, path-guard,
-- network-guard) as the only boundary. That filter cannot see inside
-- `node -e`, `pytest`, or a compiled binary, so this is a real reduction, not
-- a formality. It exists because proxy routing only reaches clients that
-- honor proxy env vars: a project whose tests speak raw postgres, or run on
-- a Node older than 24, has no other way to reach its own dev services.
--
-- Off by default and, like allow_docker_socket, deliberately not settable
-- through POST /api/projects — it belongs to the operator's
-- config/projects.json, not to anyone with a session cookie.
ALTER TABLE projects ADD COLUMN allow_unsandboxed_commands INTEGER NOT NULL DEFAULT 0;
