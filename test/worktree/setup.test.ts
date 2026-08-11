import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSetupCommand, SETUP_OUTPUT_LIMIT, describeSetupResult } from "../../src/worktree/setup.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "autocode-setup-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("worktree setup command", () => {
  it("runs the command inside the worktree and captures its output", async () => {
    const result = await runSetupCommand({
      command: "pwd && echo installed > marker.txt && echo done-installing",
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("done-installing");
    // The command's cwd is the worktree, not the harness's own cwd.
    expect(existsSync(path.join(dir, "marker.txt"))).toBe(true);
    expect(readFileSync(path.join(dir, "marker.txt"), "utf8")).toContain("installed");
  });

  it("reports a non-zero exit as failed and keeps stderr", async () => {
    const result = await runSetupCommand({
      command: "echo 'ERR_PNPM_NO_LOCKFILE' >&2; exit 3",
      cwd: dir,
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("ERR_PNPM_NO_LOCKFILE");
    expect(describeSetupResult("pnpm install", result)).toContain("exited 3");
  });

  it("kills the whole process tree on timeout instead of hanging the run", async () => {
    const result = await runSetupCommand({
      // A child that outlives its parent shell is exactly what a package
      // manager spawning a daemon looks like — the process *group* has to go.
      command: "sleep 60 & echo started; wait",
      cwd: dir,
      timeoutMs: 300,
    });

    expect(result.timedOut).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.output).toContain("started");
    expect(describeSetupResult("uv sync", result)).toContain("timed out");
  }, 20_000);

  it("streams output in batches while the command is still running", async () => {
    const chunks: string[] = [];
    const result = await runSetupCommand({
      command: "echo first; sleep 0.3; echo second",
      cwd: dir,
      timeoutMs: 30_000,
      flushIntervalMs: 50,
      onOutput: (text) => chunks.push(text),
    });

    expect(result.status).toBe("succeeded");
    // Batched, so "first" must have been delivered before the command exited
    // rather than everything arriving in one final flush.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("first");
    expect(chunks.join("")).toContain("second");
  });

  it("keeps only the tail of a very chatty command", async () => {
    const result = await runSetupCommand({
      // ~1.2MB of output — far past the cap.
      command: "for i in $(seq 1 30000); do echo 'reify:some-package: timing progress line'; done; echo FINAL_LINE",
      cwd: dir,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe("succeeded");
    expect(result.output.length).toBeLessThanOrEqual(SETUP_OUTPUT_LIMIT);
    expect(result.output).toContain("FINAL_LINE");
  }, 30_000);

  it("fails cleanly when the command can't start at all", async () => {
    const result = await runSetupCommand({
      command: "true",
      cwd: path.join(dir, "does-not-exist"),
      timeoutMs: 30_000,
    });

    expect(result.status).toBe("failed");
    expect(result.output).toContain("failed to start setup command");
  });
});
