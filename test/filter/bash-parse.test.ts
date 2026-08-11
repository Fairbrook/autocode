import { describe, expect, it } from "vitest";
import { parseBashCommand } from "../../src/filter/bash-parse.ts";

describe("parseBashCommand", () => {
  it("splits a simple pipeline into separate segments", () => {
    const segs = parseBashCommand("cat a | grep b");
    expect(segs.map((s) => s.argv0)).toEqual(["cat", "grep"]);
  });

  it("splits on && and ;", () => {
    const segs = parseBashCommand("echo a && echo b; echo c");
    expect(segs.map((s) => s.argv0)).toEqual(["echo", "echo", "echo"]);
  });

  it("peels env KEY=VALUE prefixes to find the real argv0", () => {
    const segs = parseBashCommand("env FOO=bar BAZ=qux sudo ls");
    expect(segs[0]?.argv0).toBe("sudo");
    expect(segs[0]?.argvAfterWrappers).toEqual(["sudo", "ls"]);
  });

  it("peels timeout's duration argument", () => {
    const segs = parseBashCommand("timeout 30 curl https://example.com");
    expect(segs[0]?.argv0).toBe("curl");
  });

  it("recurses into sh -c payloads", () => {
    const segs = parseBashCommand(`bash -c "rm -rf /"`);
    expect(segs.some((s) => s.argv0 === "rm")).toBe(true);
  });

  it("recurses into unquoted $(...) command substitution", () => {
    const segs = parseBashCommand("echo $(rm -rf /)");
    expect(segs.some((s) => s.argv0 === "rm")).toBe(true);
  });

  it("recurses into double-quoted $(...) command substitution", () => {
    const segs = parseBashCommand('echo "$(rm -rf /)"');
    expect(segs.some((s) => s.argv0 === "rm")).toBe(true);
  });

  it("does not recurse into single-quoted $(...) — it's inert shell text", () => {
    const segs = parseBashCommand("echo 'literal $(rm -rf /) text'");
    expect(segs).toHaveLength(1);
    expect(segs[0]?.argv0).toBe("echo");
    expect(segs.some((s) => s.argv0 === "rm")).toBe(false);
  });

  it("marks backtick substitution as unparseable rather than silently missing it", () => {
    const segs = parseBashCommand("echo `rm -rf /`");
    expect(segs.some((s) => s.unparseable)).toBe(true);
  });

  it("handles 2>&1 (fd-duplication) without corrupting argv or recording a phantom redirect", () => {
    const segs = parseBashCommand("cat package.json 2>&1");
    expect(segs).toHaveLength(1);
    expect(segs[0]?.argv0).toBe("cat");
    expect(segs[0]?.argv).toEqual(["cat", "package.json"]);
    expect(segs[0]?.redirects).toEqual([]);
  });

  it("handles 2>&1 followed by a pipe without corrupting either segment", () => {
    const segs = parseBashCommand("npm install 2>&1 | tail -30");
    expect(segs.map((s) => ({ argv0: s.argv0, argv: s.argv }))).toEqual([
      { argv0: "npm", argv: ["npm", "install"] },
      { argv0: "tail", argv: ["tail", "-30"] },
    ]);
  });

  it("still records a real file redirect combined with 2>&1", () => {
    const segs = parseBashCommand("cmd > out.log 2>&1");
    expect(segs[0]?.argv).toEqual(["cmd"]);
    expect(segs[0]?.redirects).toEqual([{ op: ">", target: "out.log" }]);
  });

  it("extracts redirect targets", () => {
    const segs = parseBashCommand("echo hi > out.txt");
    expect(segs[0]?.redirects).toEqual([{ op: ">", target: "out.txt" }]);
  });

  it("handles nested command substitution", () => {
    const segs = parseBashCommand("echo $(echo $(rm -rf /))");
    expect(segs.some((s) => s.argv0 === "rm")).toBe(true);
  });

  it("normalizes wrapped path-like argv0 to its basename", () => {
    const segs = parseBashCommand("/usr/bin/git status");
    expect(segs[0]?.argv0).toBe("git");
  });

  it("caps recursion depth rather than looping forever on pathological nesting", () => {
    let cmd = "rm -rf /";
    for (let i = 0; i < 20; i++) cmd = `echo $(${cmd})`;
    const segs = parseBashCommand(cmd);
    // Should terminate and mark something unparseable past the depth cap,
    // not hang or throw.
    expect(segs.length).toBeGreaterThan(0);
  });
});
