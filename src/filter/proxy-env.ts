/**
 * Makes host-local services (a dev database, a `supabase start` stack, a
 * docker-compose service) reachable from inside the kernel sandbox.
 *
 * Why this is needed at all: a sandboxed Bash call gets a network namespace
 * containing `lo` and nothing else — no veth, no routes. Every packet that
 * leaves does so through the sandbox runtime's HTTP proxy (in-namespace
 * `localhost:3128`) or its SOCKS proxy (`localhost:1080`), both of which run
 * on the host and enforce `sandbox.network.allowedDomains`. The runtime also
 * exports a NO_PROXY that excludes loopback and every RFC1918 range from that
 * proxying, so a connection to e.g. `127.0.0.1:54321` is attempted *directly*
 * — inside a namespace with no route to anywhere — and fails with "connection
 * refused" / "network is unreachable".
 *
 * Measured against this repo's own sandbox config (see docs/SANDBOX-FINDINGS.md):
 *
 *   curl http://127.0.0.1:54321/            -> 000 (refused, direct, no route)
 *   curl --noproxy "" --proxy $HTTP_PROXY   -> 200 (host proxy connects for us)
 *   ... same, host NOT in allowedDomains    -> 403 (allowlist still enforced)
 *
 * So the block is NO_PROXY, not the proxy, and routing through the proxy does
 * not widen the network policy: an undeclared host is refused exactly like an
 * undeclared external domain. NO_PROXY cannot be set from the parent process
 * (the runtime overwrites it), so the only lever is the command itself, which
 * is what this module builds.
 */

/**
 * NO_PROXY as the sandbox runtime exports it. Only used to *subtract* from:
 * if the runtime ever ships a different list, the worst case is that this
 * harness sets a slightly stale one, and the proxy's own allowlist — the
 * actual boundary — is unaffected either way.
 */
export const SANDBOX_DEFAULT_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  "169.254.0.0/16",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/**
 * Loopback is one thing wearing three names. A project that declares any of
 * them means "my services are on the host's loopback", and leaving the other
 * two in NO_PROXY would make `curl localhost:x` work while `curl 127.0.0.1:x`
 * silently failed — the exact confusion this whole module exists to remove.
 */
const LOOPBACK_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/** True when a NO_PROXY entry would keep `host` off the proxy. */
export function noProxyEntryCovers(entry: string, host: string): boolean {
  const e = entry.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (!e || !h) return false;
  if (e === h) return true;
  if (LOOPBACK_ALIASES.has(e) && LOOPBACK_ALIASES.has(h)) return true;

  const slash = e.indexOf("/");
  if (slash === -1) return false;
  const base = ipv4ToInt(e.slice(0, slash));
  const bits = Number(e.slice(slash + 1));
  const target = ipv4ToInt(h);
  if (base === undefined || target === undefined) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? -1 : ~((1 << (32 - bits)) - 1);
  return (base & mask) === (target & mask);
}

/**
 * The sandbox's NO_PROXY minus every entry that would keep one of `hosts`
 * off the proxy. Everything not declared by the project keeps its default
 * behavior, so an in-call loopback server (`serve & sleep 1 && curl`) still
 * works for projects that don't opt in.
 */
export function narrowNoProxy(hosts: string[]): string[] {
  if (hosts.length === 0) return [...SANDBOX_DEFAULT_NO_PROXY];
  return SANDBOX_DEFAULT_NO_PROXY.filter(
    (entry) => !hosts.some((host) => noProxyEntryCovers(entry, host))
  );
}

/**
 * Shell prefix that re-points the declared hosts at the sandbox proxy.
 * Returns "" when the project declared no local services, so those runs get
 * their commands through byte-for-byte unmodified.
 *
 * NODE_USE_ENV_PROXY makes Node 24+'s global fetch/http agent honor the proxy
 * env vars, which undici otherwise ignores entirely; it is inert on older
 * Node. Anything else that ignores proxy env (psql and other raw-TCP clients,
 * pre-24 undici) is out of reach here by construction — that is what the
 * per-project `allowUnsandboxedCommands` escape hatch is for.
 */
export function proxyEnvPrefix(hosts: string[]): string {
  if (hosts.length === 0) return "";
  const value = narrowNoProxy(hosts).join(",");
  return `export NO_PROXY='${value}' no_proxy='${value}' NODE_USE_ENV_PROXY=1; `;
}

/**
 * Applies the prefix to a Bash tool input, or returns undefined when there is
 * nothing to change (no declared hosts, non-string command, or already
 * prefixed) so callers can leave `updatedInput` off the hook output.
 */
export function withLocalServiceProxyEnv(
  toolInput: Record<string, unknown>,
  hosts: string[]
): Record<string, unknown> | undefined {
  const prefix = proxyEnvPrefix(hosts);
  if (!prefix) return undefined;
  const command = toolInput.command;
  if (typeof command !== "string" || command.length === 0) return undefined;
  if (command.startsWith(prefix)) return undefined;
  return { ...toolInput, command: prefix + command };
}
