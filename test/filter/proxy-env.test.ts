import { describe, expect, it } from "vitest";
import {
  SANDBOX_DEFAULT_NO_PROXY,
  narrowNoProxy,
  noProxyEntryCovers,
  proxyEnvPrefix,
  withLocalServiceProxyEnv,
} from "../../src/filter/proxy-env.ts";

describe("noProxyEntryCovers", () => {
  it("matches an entry against itself", () => {
    expect(noProxyEntryCovers("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(noProxyEntryCovers("localhost", "localhost")).toBe(true);
  });

  it("treats the three loopback spellings as one host", () => {
    expect(noProxyEntryCovers("localhost", "127.0.0.1")).toBe(true);
    expect(noProxyEntryCovers("127.0.0.1", "localhost")).toBe(true);
    expect(noProxyEntryCovers("::1", "127.0.0.1")).toBe(true);
  });

  it("resolves CIDR containment for the RFC1918 entries", () => {
    expect(noProxyEntryCovers("172.16.0.0/12", "172.17.0.1")).toBe(true);
    expect(noProxyEntryCovers("172.16.0.0/12", "172.32.0.1")).toBe(false);
    expect(noProxyEntryCovers("10.0.0.0/8", "10.242.236.182")).toBe(true);
    expect(noProxyEntryCovers("192.168.0.0/16", "192.168.100.9")).toBe(true);
    expect(noProxyEntryCovers("192.168.0.0/16", "127.0.0.1")).toBe(false);
  });

  it("does not match a hostname against a CIDR", () => {
    expect(noProxyEntryCovers("10.0.0.0/8", "db.internal")).toBe(false);
  });
});

describe("narrowNoProxy", () => {
  it("is a no-op when the project declared no local services", () => {
    expect(narrowNoProxy([])).toEqual(SANDBOX_DEFAULT_NO_PROXY);
  });

  it("drops every loopback spelling when any one of them is declared", () => {
    const narrowed = narrowNoProxy(["127.0.0.1"]);
    expect(narrowed).not.toContain("127.0.0.1");
    expect(narrowed).not.toContain("localhost");
    expect(narrowed).not.toContain("::1");
    // Everything else keeps its default behavior — declaring a loopback
    // service must not silently route the whole private address space.
    expect(narrowed).toContain("10.0.0.0/8");
    expect(narrowed).toContain("192.168.0.0/16");
  });

  it("drops only the CIDR that covers a declared private-range host", () => {
    const narrowed = narrowNoProxy(["172.17.0.1"]);
    expect(narrowed).not.toContain("172.16.0.0/12");
    expect(narrowed).toContain("127.0.0.1");
    expect(narrowed).toContain("10.0.0.0/8");
  });
});

describe("withLocalServiceProxyEnv", () => {
  it("leaves the command untouched when nothing is declared", () => {
    expect(withLocalServiceProxyEnv({ command: "pnpm test" }, [])).toBeUndefined();
  });

  it("prefixes an env assignment that survives compound commands", () => {
    const updated = withLocalServiceProxyEnv({ command: "pnpm test && pnpm lint" }, ["127.0.0.1"]);
    const command = updated?.command as string;
    // `export` rather than a `VAR=x cmd` prefix assignment, which would only
    // apply to the first simple command of a `&&` chain.
    expect(command.startsWith("export NO_PROXY=")).toBe(true);
    expect(command.endsWith("; pnpm test && pnpm lint")).toBe(true);
    expect(command).toContain("NODE_USE_ENV_PROXY=1");
    expect(command).not.toContain("127.0.0.1',");
  });

  it("preserves the rest of the tool input", () => {
    const updated = withLocalServiceProxyEnv(
      { command: "pnpm test", description: "run tests", timeout: 120000 },
      ["127.0.0.1"]
    );
    expect(updated?.description).toBe("run tests");
    expect(updated?.timeout).toBe(120000);
  });

  it("is idempotent, so an approved command is not prefixed twice", () => {
    const hosts = ["127.0.0.1"];
    const once = withLocalServiceProxyEnv({ command: "pnpm test" }, hosts)!;
    expect(withLocalServiceProxyEnv(once, hosts)).toBeUndefined();
  });

  it("ignores non-Bash-shaped input", () => {
    expect(withLocalServiceProxyEnv({ file_path: "/tmp/x" }, ["127.0.0.1"])).toBeUndefined();
    expect(withLocalServiceProxyEnv({ command: "" }, ["127.0.0.1"])).toBeUndefined();
  });

  it("keeps the narrowed list in the exported value", () => {
    const prefix = proxyEnvPrefix(["127.0.0.1"]);
    expect(prefix).toContain("10.0.0.0/8");
    expect(prefix).not.toContain("localhost");
  });
});
