import type { Segment } from "./types.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::]"]);

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  if (h === "host.docker.internal") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 127.0.0.0/8
  return false;
}

/** Extract a bare hostname from a URL-ish or host:port-ish string. Returns null if it doesn't look like one. */
function extractHost(raw: string): string | null {
  let s = raw.trim();
  const urlMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/\s]+)/.exec(s);
  if (urlMatch) s = urlMatch[1] ?? "";
  // strip userinfo@ and :port
  s = s.replace(/^[^@]*@/, "");
  s = s.replace(/:\d+$/, "");
  s = s.replace(/\[|\]/g, "");
  if (s === "") return null;
  return s;
}

const URL_TAKING_COMMANDS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "nc",
  "ncat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
  "ftp",
]);

const GIT_REMOTE_SUBCOMMANDS = new Set(["fetch", "pull", "clone", "ls-remote", "push"]);

/**
 * Extract every network target this segment appears to reach out to, if
 * any. Best-effort — see docs/SANDBOX-FINDINGS.md for why this is a policy
 * layer on top of the kernel sandbox, not the primary boundary, for
 * commands the kernel sandbox actually covers; and the primary boundary
 * for the dev-server/playwright/container category, which the kernel
 * sandbox can't cover across separate tool calls.
 */
export function extractNetworkTargets(segment: Segment): string[] {
  const targets: string[] = [];
  const argv0 = segment.argv0;
  const args = segment.argvAfterWrappers.slice(1);

  if (URL_TAKING_COMMANDS.has(argv0)) {
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const host = extractHost(arg);
      if (host) targets.push(host);
    }
  }

  if (argv0 === "git") {
    const sub = args[0];
    if (sub && GIT_REMOTE_SUBCOMMANDS.has(sub)) {
      for (const arg of args.slice(1)) {
        if (arg.startsWith("-")) continue;
        // git remotes are often bare hostnames/URLs/scp-style (git@host:org/repo)
        const scpStyle = /^[^/@\s]+@([^:\s]+):/.exec(arg);
        if (scpStyle) {
          targets.push(scpStyle[1] ?? "");
          continue;
        }
        const host = extractHost(arg);
        if (host && host.includes(".")) targets.push(host);
      }
    }
  }

  return targets;
}

export function hasNonLoopbackTarget(segment: Segment): boolean {
  return extractNetworkTargets(segment).some((host) => !isLoopbackHost(host));
}

export { isLoopbackHost };
