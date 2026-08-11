import { spawn } from "node:child_process";
import { scrubbedEnv } from "../agent/env.ts";

/**
 * How much of the setup command's combined stdout+stderr is kept. A
 * `pnpm install` on a cold store can emit megabytes; only the tail is ever
 * useful for diagnosing a failure, and the whole thing goes into one
 * SQLite cell.
 */
export const SETUP_OUTPUT_LIMIT = 64_000;

export interface SetupRunResult {
  status: "succeeded" | "failed";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Tail of combined stdout+stderr, capped at SETUP_OUTPUT_LIMIT chars. */
  output: string;
  durationMs: number;
}

export interface RunSetupCommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  /**
   * Called with batched output as it arrives (never per-byte: chunks are
   * coalesced on a `flushIntervalMs` timer so a chatty installer doesn't
   * turn into thousands of run_log rows / SSE frames).
   */
  onOutput?: (text: string) => void;
  flushIntervalMs?: number;
  env?: Record<string, string>;
}

/**
 * Runs the project's worktree setup command (`pnpm install`, `uv sync`, …)
 * inside a freshly created worktree.
 *
 * Deliberately NOT run through the filter engine or the SDK sandbox: this
 * is a line the operator wrote in their own config file — same trust level
 * as a devcontainer `postCreateCommand` — and it needs unrestricted network
 * access to reach package registries, which is exactly what the agent-facing
 * sandbox exists to prevent. The agent never influences this string; it comes
 * only from `projects.setup_command` / `config.setup.defaultCommand`.
 *
 * Executed via `bash -lc` so ordinary shell syntax works (`&&`, `$HOME`, and
 * version managers that need a login shell to put `pnpm`/`uv` on PATH).
 */
export function runSetupCommand(input: RunSetupCommandInput): Promise<SetupRunResult> {
  const startedAt = Date.now();
  const flushIntervalMs = input.flushIntervalMs ?? 500;

  return new Promise<SetupRunResult>((resolve) => {
    let output = "";
    let pendingOutput = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("bash", ["-lc", input.command], {
      cwd: input.cwd,
      env: input.env ?? scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a timeout kills the whole tree (an installer
      // that spawns child processes of its own) rather than just `bash`.
      detached: true,
    });

    const flush = (): void => {
      if (pendingOutput === "") return;
      const text = pendingOutput;
      pendingOutput = "";
      try {
        input.onOutput?.(text);
      } catch {
        // This runs on a timer, so an throwing consumer (a failed run_log
        // write, say) would otherwise become an unhandled exception and take
        // the whole server down mid-install. Losing a line of install output
        // is not worth that.
      }
    };
    const flushTimer = setInterval(flush, flushIntervalMs);

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-SETUP_OUTPUT_LIMIT);
      pendingOutput = (pendingOutput + text).slice(-SETUP_OUTPUT_LIMIT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, input.timeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearInterval(flushTimer);
      flush();
      resolve({
        status: exitCode === 0 && !timedOut ? "succeeded" : "failed",
        exitCode,
        signal,
        timedOut,
        output,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on("error", (err) => {
      // Failure to spawn at all (no bash on PATH, cwd gone): surface it as
      // setup output so the UI shows *why* nothing ran.
      output = (output + `\nfailed to start setup command: ${err.message}\n`).slice(
        -SETUP_OUTPUT_LIMIT
      );
      pendingOutput += `\nfailed to start setup command: ${err.message}\n`;
      settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  });
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the whole process group
  } catch {
    // Already gone — nothing to kill.
  }
}

/** One-line human summary of a finished setup run, for run_log / error fields. */
export function describeSetupResult(command: string, result: SetupRunResult): string {
  if (result.timedOut) {
    return `Worktree setup command timed out after ${Math.round(result.durationMs / 1000)}s: ${command}`;
  }
  if (result.status === "failed") {
    return `Worktree setup command exited ${result.exitCode ?? "with a signal"}: ${command}`;
  }
  return `Worktree setup command succeeded in ${Math.round(result.durationMs / 1000)}s: ${command}`;
}
