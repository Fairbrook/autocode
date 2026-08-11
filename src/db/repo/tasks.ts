import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { TaskRow, TaskStatus } from "../../types.ts";

export function createTask(
  db: Db,
  input: { projectId: number; title: string; description: string }
): TaskRow {
  const ts = nowIso();
  const result = db
    .prepare(
      `INSERT INTO tasks (project_id, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?)`
    )
    .run(input.projectId, input.title, input.description, ts, ts);
  const row = getTask(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created task");
  return row;
}

export function getTask(db: Db, id: number): TaskRow | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | TaskRow
    | undefined;
}

export function listTasks(db: Db): TaskRow[] {
  return db
    .prepare("SELECT * FROM tasks ORDER BY id DESC")
    .all() as unknown as TaskRow[];
}

export function setTaskStatus(db: Db, id: number, status: TaskStatus): void {
  db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    id
  );
}
