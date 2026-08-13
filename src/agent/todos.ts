import { z } from "zod";
import type { TodoItem } from "../types.ts";

const TodoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
  // Older CLI builds omitted activeForm; fall back to the content so the UI
  // always has something to show while an item is in progress.
  activeForm: z.string().optional(),
});

const TodoWriteInputSchema = z.object({ todos: z.array(TodoItemSchema) });

const TaskCreateInputSchema = z.object({
  subject: z.string(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
});

const TaskUpdateInputSchema = z.object({
  taskId: z.union([z.string(), z.number()]),
  subject: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional(),
});

/**
 * Pulls the agent's todo list out of a message's content blocks by looking
 * for a `TodoWrite` tool_use.
 *
 * Kept for CLI builds that still drive the list through TodoWrite. Current
 * builds use TaskCreate/TaskUpdate instead — see createTaskListTracker.
 *
 * Returns null when the message has no TodoWrite at all (the common case)
 * or when its input doesn't parse — a malformed todo list is never worth
 * failing a run over.
 */
export function extractTodosFromContent(content: unknown): TodoItem[] | null {
  if (!Array.isArray(content)) return null;

  let latest: TodoItem[] | null = null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; name?: unknown; input?: unknown };
    if (b.type !== "tool_use" || b.name !== "TodoWrite") continue;

    const parsed = TodoWriteInputSchema.safeParse(b.input);
    if (!parsed.success) continue;
    latest = parsed.data.todos.map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm ?? t.content,
    }));
  }
  return latest;
}

interface TrackedTask extends TodoItem {
  id: string;
}

export interface TaskListTracker {
  /**
   * Feed one assistant/user message's content blocks. Returns the new list
   * when this message changed it, or null when it didn't — same contract as
   * extractTodosFromContent, so callers stay a one-liner.
   */
  applyMessageContent(content: unknown): TodoItem[] | null;
  /** `TaskCreated` hook — the authoritative source of a task's id. */
  onTaskCreated(input: { task_id: string; task_subject: string }): TodoItem[];
  /** `TaskCompleted` hook. */
  onTaskCompleted(input: { task_id: string }): TodoItem[];
  snapshot(): TodoItem[];
}

/**
 * Mirrors the agent's task list — the UI's progress feed — into a plain
 * TodoItem[].
 *
 * Two sources, because neither is complete on its own:
 *
 *  - The `TaskCreated`/`TaskCompleted` **hooks** carry `task_id`, which is
 *    the only reliable way to learn the id the agent will later pass to
 *    `TaskUpdate` (the TaskCreate *tool call* doesn't contain it — the id
 *    comes back in the tool result text, "Task #3 created successfully:
 *    ...", which is not a shape worth parsing).
 *  - The `TaskUpdate` **tool call** carries status transitions. There is no
 *    `TaskUpdated` hook (see HOOK_EVENTS in the SDK), so without reading
 *    the tool call, an item would jump from pending straight to completed
 *    and "in progress" would never render.
 *
 * `TaskCreate`'s tool call is read too, purely for `activeForm`, which the
 * hook doesn't carry. It arrives before the hook fires (the model emits the
 * call, then the tool executes), so it is stashed by subject and claimed by
 * the next matching TaskCreated.
 *
 * TodoWrite still wins outright when it appears: it has replace semantics
 * and an older CLI driving the list that way isn't also emitting Task*
 * calls.
 */
export function createTaskListTracker(): TaskListTracker {
  const tasks: TrackedTask[] = [];
  /** activeForm from a TaskCreate call whose TaskCreated hook hasn't fired yet, keyed by subject. */
  const pendingActiveForms = new Map<string, string>();
  let todoWriteList: TodoItem[] | null = null;

  function snapshot(): TodoItem[] {
    if (todoWriteList) return todoWriteList;
    return tasks.map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm,
    }));
  }

  function find(taskId: string): TrackedTask | undefined {
    return tasks.find((t) => t.id === taskId);
  }

  return {
    snapshot,

    onTaskCreated({ task_id, task_subject }) {
      const existing = find(String(task_id));
      const activeForm = pendingActiveForms.get(task_subject) ?? task_subject;
      pendingActiveForms.delete(task_subject);
      if (existing) {
        existing.content = task_subject;
        existing.activeForm = activeForm;
      } else {
        tasks.push({
          id: String(task_id),
          content: task_subject,
          status: "pending",
          activeForm,
        });
      }
      return snapshot();
    },

    onTaskCompleted({ task_id }) {
      const existing = find(String(task_id));
      if (existing) existing.status = "completed";
      return snapshot();
    },

    applyMessageContent(content) {
      const todoWrite = extractTodosFromContent(content);
      if (todoWrite) {
        todoWriteList = todoWrite;
        return todoWrite;
      }
      if (!Array.isArray(content)) return null;

      let changed = false;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: unknown; name?: unknown; input?: unknown };
        if (b.type !== "tool_use") continue;

        if (b.name === "TaskCreate") {
          const parsed = TaskCreateInputSchema.safeParse(b.input);
          if (!parsed.success) continue;
          if (parsed.data.activeForm) {
            pendingActiveForms.set(parsed.data.subject, parsed.data.activeForm);
          }
          continue; // the id — and therefore the list entry — comes from the hook
        }

        if (b.name === "TaskUpdate") {
          const parsed = TaskUpdateInputSchema.safeParse(b.input);
          if (!parsed.success) continue;
          const { taskId, subject, activeForm, status } = parsed.data;
          const task = find(String(taskId));
          if (!task) continue; // an update for a task whose TaskCreated we never saw
          if (subject !== undefined) task.content = subject;
          if (activeForm !== undefined) task.activeForm = activeForm;
          if (status === "deleted") {
            tasks.splice(tasks.indexOf(task), 1);
          } else if (status !== undefined) {
            task.status = status;
          }
          changed = true;
        }
      }
      return changed ? snapshot() : null;
    },
  };
}
