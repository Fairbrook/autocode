import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.ts";
import {
  upsertBackgroundTaskStarted,
  markBackgroundTaskStatus,
  listRunningBackgroundTasks,
} from "../db/repo/background.ts";

/**
 * Tracks background work (backgrounded Bash commands — dev servers,
 * primarily — and backgrounded subagent launches) for one run, per
 * docs/SANDBOX-FINDINGS.md's confirmed mechanism:
 *
 *  - `TaskCreated`/`TaskCompleted` hooks fire on start/end with a
 *    human-readable subject/description, keyed by `task_id`.
 *  - `PostToolUse` on `Bash` carries `tool_response.backgroundTaskId` when
 *    a command was backgrounded — this is what ties a `task_id` back to
 *    the actual command string (the hooks alone don't distinguish a
 *    Bash-originated task from a subagent-originated one).
 *  - The `system`/`background_tasks_changed` message on the main message
 *    stream (not a hook — see session-runner.ts) is the authoritative
 *    LEVEL signal for "what's running right now": REPLACE semantics, so
 *    reconcileLiveSet below treats its payload as the full current set,
 *    not an edge to pair against TaskCreated/TaskCompleted.
 */
export function createBackgroundHooks(
  db: Db,
  runId: number
): { taskCreated: HookCallback; taskCompleted: HookCallback; postToolUseBash: HookCallback } {
  const taskCreated: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "TaskCreated") return {};
    upsertBackgroundTaskStarted(db, {
      runId,
      sdkTaskId: input.task_id,
      description: input.task_subject,
    });
    return {};
  };

  const taskCompleted: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "TaskCompleted") return {};
    markBackgroundTaskStatus(db, runId, input.task_id, "completed");
    return {};
  };

  const postToolUseBash: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    if (input.tool_name !== "Bash") return {};
    const response = input.tool_response as { backgroundTaskId?: string } | undefined;
    const backgroundTaskId = response?.backgroundTaskId;
    if (!backgroundTaskId) return {};
    const command =
      typeof input.tool_input === "object" && input.tool_input !== null
        ? (input.tool_input as { command?: string }).command
        : undefined;
    upsertBackgroundTaskStarted(db, {
      runId,
      sdkTaskId: backgroundTaskId,
      taskType: "bash_background",
      command: command ?? null,
    });
    return {};
  };

  return { taskCreated, taskCompleted, postToolUseBash };
}

/**
 * Called from session-runner.ts whenever a `background_tasks_changed`
 * system message arrives. REPLACE semantics per the SDK's own docstring:
 * anything the DB still has marked "running" that ISN'T in this payload
 * has ended (completed or killed — TaskCompleted should also have fired,
 * this is a backstop for a missed edge); anything IN this payload gets
 * upserted in case TaskCreated was missed.
 */
export function reconcileLiveSet(
  db: Db,
  runId: number,
  liveTasks: { task_id: string; task_type: string; description: string }[]
): void {
  const liveIds = new Set(liveTasks.map((t) => t.task_id));
  for (const t of liveTasks) {
    upsertBackgroundTaskStarted(db, {
      runId,
      sdkTaskId: t.task_id,
      taskType: t.task_type,
      description: t.description,
    });
  }
  for (const running of listRunningBackgroundTasks(db, runId)) {
    if (!liveIds.has(running.sdk_task_id)) {
      markBackgroundTaskStatus(db, runId, running.sdk_task_id, "completed");
    }
  }
}

/**
 * Called once the query() loop has fully returned (the CLI subprocess for
 * this run has exited). Anything still marked "running" at this point is,
 * from the harness's perspective, unaccounted for — the subprocess exiting
 * ordinarily takes its children with it, but the harness has no way to
 * confirm that after the fact, so this is recorded honestly as "leaked"
 * rather than silently assumed cleaned up. Surfaced via
 * metrics.background_leaked_count.
 */
export function reconcileAtRunEnd(db: Db, runId: number): number {
  const stillRunning = listRunningBackgroundTasks(db, runId);
  for (const task of stillRunning) {
    markBackgroundTaskStatus(db, runId, task.sdk_task_id, "leaked", {
      stopAttempted: false,
      stopResult: "Run ended with this task still marked running; harness process exited without an explicit TaskStop.",
    });
  }
  return stillRunning.length;
}
