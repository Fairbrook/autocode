import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.ts";
import { appendRunLog } from "../db/repo/log.ts";
import { setRunStatus } from "../db/repo/runs.ts";
import { setTaskStatus } from "../db/repo/tasks.ts";
import { markWorktreeSetupStarted, markWorktreeSetupFinished } from "../db/repo/worktrees.ts";
import { runImplementer } from "../agent/implementer.ts";
import { runSetupCommand, describeSetupResult } from "../worktree/setup.ts";
import type { PlanRow, ProjectRow, RunRow, TaskRow, WorktreeRow } from "../types.ts";
import type { Fanout } from "../notify/index.ts";

/** The agent half of the pipeline, injectable so tests can drive setup without a live model call. */
export type RunAgent = typeof runImplementer;

export interface ImplementationPipelineInput {
  db: Db;
  task: TaskRow;
  project: ProjectRow;
  plan: PlanRow;
  worktree: WorktreeRow;
  run: RunRow;
  /** Resolved from project.setup_command ?? config.setup.defaultCommand; null skips setup entirely. */
  setupCommand: string | null;
  setupTimeoutMs: number;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  canUseTool: CanUseTool;
  fanout: Fanout;
  logError: (context: Record<string, unknown>, message: string) => void;
  runAgent?: RunAgent;
}

/**
 * Everything that happens after `POST /api/plans/:id/implement` returns 202:
 * install the project's dependencies into the fresh worktree, then hand it
 * to the implementation agent.
 *
 * Both halves report into the same run row and the same run_log, so the UI
 * has one live channel to watch from the moment the button is clicked —
 * "installing dependencies" is, from the user's point of view, the first
 * thing this run does.
 */
export async function runImplementationPipeline(
  input: ImplementationPipelineInput
): Promise<void> {
  const { db, task, project, plan, worktree, run, setupCommand } = input;

  if (setupCommand) {
    markWorktreeSetupStarted(db, worktree.id, setupCommand);
    appendRunLog(db, run.id, "setup_status", { status: "running", command: setupCommand });

    const setup = await runSetupCommand({
      command: setupCommand,
      cwd: worktree.worktree_path,
      timeoutMs: input.setupTimeoutMs,
      onOutput: (text) => appendRunLog(db, run.id, "setup_output", { text }),
    });

    markWorktreeSetupFinished(db, worktree.id, {
      status: setup.status,
      exitCode: setup.exitCode,
      output: setup.output,
    });
    appendRunLog(db, run.id, "setup_status", {
      status: setup.status,
      command: setupCommand,
      exitCode: setup.exitCode,
      timedOut: setup.timedOut,
      durationMs: setup.durationMs,
    });

    if (setup.status === "failed") {
      // Handing the agent a worktree with no dependencies installed just
      // burns the run's budget on failures it can't diagnose. Stop here and
      // let the user fix the command or the environment.
      const summary = describeSetupResult(setupCommand, setup);
      input.logError({ taskId: task.id, worktreeId: worktree.id }, summary);
      setRunStatus(db, run.id, "failed", { error: summary });
      appendRunLog(db, run.id, "status", { status: "failed", error: summary });
      setTaskStatus(db, task.id, "failed");
      input.fanout({
        kind: "run_failed",
        runId: run.id,
        title: "Worktree setup failed",
        body: summary,
      });
      return;
    }

    setTaskStatus(db, task.id, "implementing");
  }

  const runAgent = input.runAgent ?? runImplementer;
  const outcome = await runAgent({
    db,
    task,
    project,
    plan,
    worktree,
    run,
    model: input.model,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    canUseTool: input.canUseTool,
  });

  if (!outcome.ok) {
    input.logError({ taskId: task.id, error: outcome.errorSummary }, "implementer run failed");
  }
  setTaskStatus(db, task.id, outcome.ok ? "done" : "failed");
  input.fanout({
    kind: outcome.ok ? "run_complete" : "run_failed",
    runId: outcome.runId,
    title: outcome.ok ? "Implementation finished" : "Implementation failed",
    body: outcome.ok
      ? `Background tasks leaked: ${outcome.backgroundLeakedCount}`
      : outcome.errorSummary ?? "Unknown error",
  });
}
