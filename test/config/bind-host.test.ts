import { describe, expect, it } from "vitest";
import { networkInterfaces } from "node:os";
import { resolveBindHost } from "../../src/config.ts";

describe("resolveBindHost", () => {
  it("passes plain addresses through untouched", () => {
    expect(resolveBindHost("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveBindHost("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveBindHost("10.242.236.182")).toBe("10.242.236.182");
  });

  it("resolves iface:<name> to that interface's IPv4 address", () => {
    // `lo` is the one interface every machine running these tests has.
    expect(resolveBindHost("iface:lo")).toBe("127.0.0.1");
  });

  it("names the missing interface, rather than failing later with EADDRNOTAVAIL", () => {
    expect(() => resolveBindHost("iface:zt-does-not-exist")).toThrow(
      /does not exist.*Available:/s
    );
  });

  it("resolves whichever VPN-ish interface this host actually has, if any", () => {
    // Not an assertion about this machine's setup — it just proves the
    // lookup works against a real, non-loopback interface when one exists.
    const candidate = Object.entries(networkInterfaces()).find(
      ([name, addrs]) => name !== "lo" && addrs?.some((a) => a.family === "IPv4")
    );
    if (!candidate) return;
    const [name, addrs] = candidate;
    const expected = addrs!.find((a) => a.family === "IPv4")!.address;
    expect(resolveBindHost(`iface:${name}`)).toBe(expected);
  });
});
