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

/**
 * Pulls the agent's todo list out of a message's content blocks by looking
 * for a `TodoWrite` tool_use.
 *
 * This is the harness's window into what the agent thinks it's doing: the
 * SDK exposes no dedicated todo message type, and TodoWrite's *result*
 * never reaches the transcript in a useful shape, so the tool call's input
 * is the signal. A message can legally contain more than one tool_use
 * block; the last TodoWrite wins, matching the tool's replace semantics.
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
