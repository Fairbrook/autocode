import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { BackgroundTaskRow, BackgroundTaskStatus } from "../../types.ts";

export function upsertBackgroundTaskStarted(
  db: Db,
  input: {
    runId: number;
    sdkTaskId: string;
    taskType?: string | null;
    description?: string | null;
    command?: string | null;
  }
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO background_tasks (run_id, sdk_task_id, task_type, description, command, started_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running')
     ON CONFLICT(run_id, sdk_task_id) DO UPDATE SET
       task_type = COALESCE(excluded.task_type, background_tasks.task_type),
       description = COALESCE(excluded.description, background_tasks.description),
       command = COALESCE(excluded.command, background_tasks.command),
       last_seen_at = excluded.last_seen_at`
  ).run(
    input.runId,
    input.sdkTaskId,
    input.taskType ?? null,
    input.description ?? null,
    input.command ?? null,
    ts,
    ts
  );
}

export function touchBackgroundTaskSeen(
  db: Db,
  runId: number,
  sdkTaskId: string
): void {
  db.prepare(
    "UPDATE background_tasks SET last_seen_at = ? WHERE run_id = ? AND sdk_task_id = ?"
  ).run(nowIso(), runId, sdkTaskId);
}

export function markBackgroundTaskStatus(
  db: Db,
  runId: number,
  sdkTaskId: string,
  status: BackgroundTaskStatus,
  extra?: { stopAttempted?: boolean; stopResult?: string }
): void {
  const ended = status === "completed" || status === "killed";
  db.prepare(
    `UPDATE background_tasks SET status = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
       stop_attempted_at = CASE WHEN ? THEN ? ELSE stop_attempted_at END,
       stop_result = COALESCE(?, stop_result)
     WHERE run_id = ? AND sdk_task_id = ?`
  ).run(
    status,
    ended ? 1 : 0,
    nowIso(),
    extra?.stopAttempted ? 1 : 0,
    nowIso(),
    extra?.stopResult ?? null,
    runId,
    sdkTaskId
  );
}

export function listRunningBackgroundTasks(
  db: Db,
  runId: number
): BackgroundTaskRow[] {
  return db
    .prepare(
      "SELECT * FROM background_tasks WHERE run_id = ? AND status = 'running'"
    )
    .all(runId) as unknown as BackgroundTaskRow[];
}

export function listBackgroundTasks(db: Db, runId: number): BackgroundTaskRow[] {
  return db
    .prepare("SELECT * FROM background_tasks WHERE run_id = ? ORDER BY id")
    .all(runId) as unknown as BackgroundTaskRow[];
}
