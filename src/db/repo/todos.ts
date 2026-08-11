import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { RunTodosRow, TodoItem } from "../../types.ts";

/**
 * TodoWrite sends the complete list every time (REPLACE semantics), so one
 * row per run always holds the current state — no merging, no per-item
 * identity to track. The full history is still in run_log (kind='todos').
 */
export function upsertRunTodos(db: Db, runId: number, todos: TodoItem[]): void {
  db.prepare(
    `INSERT INTO run_todos (run_id, todos_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       todos_json = excluded.todos_json,
       updated_at = excluded.updated_at`
  ).run(runId, JSON.stringify(todos), nowIso());
}

/** Returns null when the run never wrote a todo list (e.g. it failed before its first turn). */
export function getRunTodos(db: Db, runId: number): TodoItem[] | null {
  const row = db.prepare("SELECT * FROM run_todos WHERE run_id = ?").get(runId) as
    | RunTodosRow
    | undefined;
  if (!row) return null;
  return JSON.parse(row.todos_json) as TodoItem[];
}
