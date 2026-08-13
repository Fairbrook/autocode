import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.ts";
import { appendRunLog } from "../db/repo/log.ts";
import { setRunStatus, setRunSdkSessionId } from "../db/repo/runs.ts";
import { upsertMetrics } from "../db/repo/metrics.ts";
import { upsertRunTodos } from "../db/repo/todos.ts";
import type { RunPhase, TodoItem } from "../types.ts";
import { scrubbedEnv } from "./env.ts";
import { createTaskListTracker } from "./todos.ts";

export interface SessionRunResult {
  ok: boolean;
  sessionId: string | undefined;
  structuredOutput: unknown;
  resultText: string | undefined;
  errorSummary: string | undefined;
}

export interface RunSessionInput {
  db: Db;
  runId: number;
  phase: RunPhase;
  prompt: string;
  cwd: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: Options["permissionMode"];
  planModeInstructions?: string;
  outputFormat?: Options["outputFormat"];
  hooks?: Options["hooks"];
  canUseTool?: Options["canUseTool"];
  sandbox?: Options["sandbox"];
  settingSources?: Options["settingSources"];
  /** Cooperative cancellation — resolve/wire this to a stop endpoint. */
  abortController?: AbortController;
  /**
   * Fired for every `system`/`background_tasks_changed` message — the
   * authoritative REPLACE-semantics liveness signal for background work.
   * See src/background/tracker.ts.
   */
  onBackgroundTasksChanged?: (
    tasks: { task_id: string; task_type: string; description: string }[]
  ) => void;
}

/**
 * Shared query() driver used by both the planner and the implementer.
 * Streams every SDK message into run_log (the SSE replay buffer), and
 * writes the metrics row once the query completes. The async generator's
 * natural completion — after it yields the terminal `result` message — is
 * the single authoritative "this run is done" signal; Stop/SessionEnd hooks
 * (if the caller registers them) are for side effects only, not relied on
 * here for completion detection, since there's no race within one
 * synchronously-consumed `query()` call.
 */
export async function runSession(input: RunSessionInput): Promise<SessionRunResult> {
  const { db, runId, phase } = input;
  setRunStatus(db, runId, "running");
  appendRunLog(db, runId, "status", { status: "running", phase });

  // The agent's task list is mirrored here rather than by the caller because
  // it takes two signals that arrive on two different channels — the
  // TaskCreated/TaskCompleted hooks and the TaskUpdate tool call — and both
  // phases want the same behavior. See src/agent/todos.ts.
  const taskList = createTaskListTracker();
  function publishTodos(todos: TodoItem[]): void {
    upsertRunTodos(db, runId, todos);
    appendRunLog(db, runId, "todos", { todos });
  }
  const taskListHooks: Options["hooks"] = {
    TaskCreated: [
      {
        hooks: [
          async (hookInput) => {
            if (hookInput.hook_event_name !== "TaskCreated") return {};
            publishTodos(taskList.onTaskCreated(hookInput));
            return {};
          },
        ],
      },
    ],
    TaskCompleted: [
      {
        hooks: [
          async (hookInput) => {
            if (hookInput.hook_event_name !== "TaskCompleted") return {};
            publishTodos(taskList.onTaskCompleted(hookInput));
            return {};
          },
        ],
      },
    ],
  };
  const hooks = mergeHooks(input.hooks, taskListHooks);

  const options: Options = {
    cwd: input.cwd,
    model: input.model,
    maxTurns: input.maxTurns,
    ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
    permissionMode: input.permissionMode ?? "default",
    ...(input.planModeInstructions !== undefined ? { planModeInstructions: input.planModeInstructions } : {}),
    ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
    ...(input.disallowedTools !== undefined ? { disallowedTools: input.disallowedTools } : {}),
    ...(input.outputFormat !== undefined ? { outputFormat: input.outputFormat } : {}),
    hooks,
    ...(input.canUseTool !== undefined ? { canUseTool: input.canUseTool } : {}),
    ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
    settingSources: input.settingSources ?? [],
    env: scrubbedEnv(),
    ...(input.abortController !== undefined ? { abortController: input.abortController } : {}),
  };

  let structuredOutput: unknown;
  let resultText: string | undefined;
  let sessionId: string | undefined;
  let ok = false;
  let errorSummary: string | undefined;
  let toolCallCounts: Record<string, number> = {};

  try {
    for await (const message of query({ prompt: input.prompt, options })) {
      handleMessage(message);
    }
  } catch (err) {
    errorSummary = (err as Error).message;
    appendRunLog(db, runId, "error", { message: errorSummary });
  }

  function handleMessage(message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
      setRunSdkSessionId(db, runId, message.session_id);
      appendRunLog(db, runId, "system_init", {
        session_id: message.session_id,
        model: message.model,
        apiKeySource: message.apiKeySource,
      });
      return;
    }

    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      input.onBackgroundTasksChanged?.(message.tasks);
      appendRunLog(db, runId, "background_tasks_changed", { tasks: message.tasks });
      return;
    }

    if (message.type === "assistant" || message.type === "user") {
      for (const block of message.message.content) {
        if (typeof block !== "object" || block === null) continue;
        if ("type" in block && block.type === "tool_use" && "name" in block) {
          const name = String(block.name);
          toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
        }
      }
      appendRunLog(db, runId, message.type, { content: message.message.content });

      // The agent's own task list, mirrored into the DB + the SSE stream so
      // the UI can show what it's working on right now rather than making
      // the user infer it from a wall of tool calls.
      const todos = taskList.applyMessageContent(message.message.content);
      if (todos) publishTodos(todos);
      return;
    }

    if (message.type === "result") {
      ok = message.subtype === "success";
      resultText = "result" in message ? message.result : undefined;
      structuredOutput = "structured_output" in message ? message.structured_output : undefined;
      if (!ok) errorSummary = summarizeError(message);

      upsertMetrics(db, {
        runId,
        phase,
        resultSubtype: message.subtype,
        isError: message.is_error,
        stopReason: "stop_reason" in message ? message.stop_reason : null,
        durationMs: "duration_ms" in message ? message.duration_ms : null,
        durationApiMs: "duration_api_ms" in message ? message.duration_api_ms : null,
        numTurns: "num_turns" in message ? message.num_turns : null,
        totalCostUsd: "total_cost_usd" in message ? message.total_cost_usd : null,
        inputTokens: "usage" in message ? message.usage?.input_tokens ?? null : null,
        outputTokens: "usage" in message ? message.usage?.output_tokens ?? null : null,
        cacheReadTokens: "usage" in message ? message.usage?.cache_read_input_tokens ?? null : null,
        cacheCreationTokens: "usage" in message ? message.usage?.cache_creation_input_tokens ?? null : null,
        modelUsage: "modelUsage" in message ? message.modelUsage : null,
        toolCallCounts,
        sdkPermissionDenials: "permission_denials" in message ? message.permission_denials?.length ?? 0 : 0,
      });
      appendRunLog(db, runId, "result", {
        subtype: message.subtype,
        total_cost_usd: "total_cost_usd" in message ? message.total_cost_usd : undefined,
      });
      return;
    }

    appendRunLog(db, runId, message.type, message as unknown as Record<string, unknown>);
  }

  setRunStatus(db, runId, ok ? "completed" : "failed", { error: errorSummary });
  appendRunLog(db, runId, "status", { status: ok ? "completed" : "failed", error: errorSummary });

  return { ok, sessionId, structuredOutput, resultText, errorSummary };
}

/**
 * Union of two hook maps, per event. The caller's matchers run first; ours
 * are appended rather than replacing them, so registering a TaskCreated hook
 * of your own doesn't silently switch off the task-list mirror.
 */
function mergeHooks(callerHooks: Options["hooks"], ownHooks: Options["hooks"]): Options["hooks"] {
  const merged: Record<string, unknown[]> = {};
  for (const source of [callerHooks, ownHooks]) {
    if (!source) continue;
    for (const [event, matchers] of Object.entries(source)) {
      if (!matchers) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged as Options["hooks"];
}

function summarizeError(message: SDKMessage): string {
  if (message.type !== "result") return "unknown error";
  if ("errors" in message && Array.isArray(message.errors)) {
    return message.errors.join("; ");
  }
  return message.subtype;
}

export type { HookCallback };
