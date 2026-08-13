import { readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  port: z.number().int().positive(),
  host: z.string(),
  dataDir: z.string(),
  worktreeRoot: z.string(),
  models: z.object({
    planner: z.string(),
    implementer: z.string(),
  }),
  budgets: z.object({
    plannerMaxTurns: z.number().int().positive(),
    plannerMaxBudgetUsd: z.number().positive(),
    implementerMaxTurns: z.number().int().positive(),
    implementerMaxBudgetUsd: z.number().positive(),
  }),
  approvals: z.object({
    pendingTimeoutMs: z.number().int().positive(),
  }),
  setup: z
    .object({
      /**
       * Shell line run once inside every newly created worktree, for
       * projects that don't set their own `setupCommand`. Null disables
       * setup entirely by default — dependency install is per-ecosystem
       * (`pnpm install`, `uv sync`, `bundle install`), so the useful place
       * to set it is almost always per project.
       */
      defaultCommand: z.string().nullable().default(null),
      timeoutMs: z.number().int().positive().default(900_000),
    })
    .default({ defaultCommand: null, timeoutMs: 900_000 }),
  notify: z.object({
    desktop: z.boolean(),
    sse: z.boolean(),
    webPush: z.boolean(),
  }),
  auth: z
    .object({
      cookieName: z.string().default("autocode_session"),
      /**
       * `true` marks the session cookie Secure, so browsers only ever send
       * it over HTTPS. `"auto"` decides per response from how that request
       * arrived (see resolveCookieSecure) — the right setting when the app
       * is served over plain HTTP inside a VPN like ZeroTier, where a
       * hard `true` would stop the browser from ever returning the cookie
       * and login would appear to silently fail. `false` never marks it.
       */
      cookieSecure: z.union([z.boolean(), z.literal("auto")]).default(true),
      sessionTtlHours: z.number().positive().default(720),
      maxFailedAttempts: z.number().int().positive().default(10),
      lockoutMinutes: z.number().positive().default(15),
      /**
       * Extra origins accepted on state-changing requests, e.g.
       * "https://autocode.example.com". Only needed when a reverse proxy
       * doesn't forward the browser's host — nginx sends the *upstream*
       * address as Host unless told otherwise, which would otherwise make
       * every write look like a cross-site forgery.
       */
      trustedOrigins: z.array(z.string()).default([]),
    })
    .default({
      cookieName: "autocode_session",
      cookieSecure: true as boolean | "auto",
      sessionTtlHours: 720,
      maxFailedAttempts: 10,
      lockoutMinutes: 15,
      trustedOrigins: [] as string[],
    }),
  /**
   * Which upstream addresses may set X-Forwarded-* headers. Accepts an IP, a
   * CIDR subnet, a comma-separated list, or a boolean.
   *
   * Two things depend on it behind a proxy: `req.ip` (the login throttle
   * keys on it — without this, *every* request appears to come from the
   * proxy, so one attacker's failures lock out everybody) and `req.protocol`
   * (which `cookieSecure: "auto"` reads to decide the Secure flag).
   *
   * Never `true` on an internet-facing deployment: it lets any client spoof
   * X-Forwarded-For and walk past the per-IP lockout. Name the proxy, or the
   * subnet it lives on.
   */
  trustProxy: z.union([z.boolean(), z.string()]).default(false),
});

export type Config = z.infer<typeof ConfigSchema> & {
  dataDir: string;
  worktreeRoot: string;
  dbPath: string;
};

export const ProjectSeedSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  defaultBaseRef: z.string().default("HEAD"),
  ruleProfile: z.string().nullable().default(null),
  allowedNetworkDomains: z.array(z.string()).default([]),
  /**
   * Run once in each new worktree before the implementation agent starts —
   * e.g. "pnpm install --frozen-lockfile" or "uv sync". Null falls back to
   * `setup.defaultCommand` in autocode.json; if that's null too, setup is
   * skipped. Unlike agent commands this is NOT filtered or sandboxed: it's
   * a line the operator wrote in their own config file, on the same footing
   * as a devcontainer postCreateCommand.
   */
  setupCommand: z.string().nullable().default(null),
  /**
   * Lets sandboxed commands in this project's worktrees connect to Unix
   * sockets, which is the one thing `docker`/`podman` need and don't get:
   * the CLI talks to the daemon over /var/run/docker.sock, and the sandbox
   * blocks AF_UNIX by default. Leave it off unless the project's build or
   * tests genuinely need containers.
   *
   * On Linux this cannot be scoped to the docker socket alone — seccomp
   * can't filter sockets by path, so the SDK only offers the all-or-nothing
   * `network.allowAllUnixSockets`. Turning it on therefore un-blocks *every*
   * Unix socket for this project's runs, and reaching the docker daemon is
   * root-equivalent regardless: a container can bind-mount anything the
   * daemon can see and gets unrestricted network egress the filter engine
   * cannot inspect. Deliberately absent from POST /api/projects — see the
   * 005 migration and docs/SANDBOX-FINDINGS.md.
   */
  allowDockerSocket: z.boolean().default(false),
  /**
   * Hosts this project's dev services listen on, e.g. ["127.0.0.1"] for a
   * local `supabase start` stack. A sandboxed command cannot reach them
   * directly at all — its network namespace has only `lo` and no routes —
   * so the harness routes these hosts through the sandbox runtime's proxy
   * instead (see src/filter/proxy-env.ts). They are merged into
   * allowedNetworkDomains automatically, since the proxy enforces that
   * allowlist for local targets exactly as it does for external ones.
   *
   * Only reaches clients that honor proxy env vars: curl, git, pnpm/npm, and
   * Node 24+ (via NODE_USE_ENV_PROXY, which this sets). Raw-TCP clients like
   * psql, and undici on Node < 24, ignore it — those need
   * allowUnsandboxedCommands below.
   */
  localServiceHosts: z.array(z.string()).default([]),
  /**
   * Runs this project's build/test, dev-server, playwright and container
   * commands *outside* the kernel sandbox, leaving the harness filter (argv
   * allow-list, path-guard, network-guard) as the only boundary. Without it
   * the SDK ignores `dangerouslyDisableSandbox` entirely, so the filter
   * engine's `sandboxOverride` rules are inert.
   *
   * The escape hatch for projects whose tests genuinely cannot be reached by
   * proxy routing — raw postgres/redis connections, Node < 24 — and a real
   * reduction in enforcement, since no argv-level filter can see what
   * `pytest` or `node -e` does once it is running. Off by default and, like
   * allowDockerSocket, absent from POST /api/projects on purpose.
   */
  allowUnsandboxedCommands: z.boolean().default(false),
});
export type ProjectSeed = z.infer<typeof ProjectSeedSchema>;

/**
 * Resolves a `host` config value to an address to bind. Plain addresses
 * pass through; `iface:<name>` resolves to that interface's current IPv4
 * address.
 *
 * The indirection exists for VPN interfaces (ZeroTier, WireGuard,
 * Tailscale): binding to the VPN address is what keeps the app off the LAN
 * and off the public internet, but that address is assigned by the network
 * controller and can change. Naming the interface survives a re-assignment,
 * and — more importantly — turns "VPN wasn't up yet at boot" from a bare
 * EADDRNOTAVAIL into a message that says so.
 *
 * Resolved at listen time, not load time, so tools that only need the
 * database (scripts/create-user.ts) still work when the VPN is down.
 */
export function resolveBindHost(host: string): string {
  if (!host.startsWith("iface:")) return host;
  const name = host.slice("iface:".length);
  const addresses = networkInterfaces()[name];
  if (!addresses || addresses.length === 0) {
    throw new Error(
      `Network interface "${name}" does not exist. Available: ${Object.keys(networkInterfaces()).join(", ")}`
    );
  }
  const ipv4 = addresses.find((a) => a.family === "IPv4");
  if (!ipv4) {
    throw new Error(
      `Network interface "${name}" has no IPv4 address yet — is the VPN up? (systemctl status zerotier-one)`
    );
  }
  return ipv4.address;
}

/** Expand a leading `~` to the user's home directory. Does not touch any other `~` occurrence. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(configPath: string): Config {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const parsed = ConfigSchema.parse(raw);
  const dataDir = expandHome(parsed.dataDir);
  const worktreeRoot = expandHome(parsed.worktreeRoot);
  return {
    ...parsed,
    dataDir,
    worktreeRoot,
    dbPath: path.join(dataDir, "autocode.db"),
  };
}

export function loadProjectSeeds(projectsPath: string): ProjectSeed[] {
  const raw = JSON.parse(readFileSync(projectsPath, "utf8"));
  const seeds = z.array(ProjectSeedSchema).parse(raw);
  return seeds.map((s) => ({ ...s, repoPath: expandHome(s.repoPath) }));
}
