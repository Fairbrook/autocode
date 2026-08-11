import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { RunPhase, RunRow, RunStatus } from "../../types.ts";

export function createRun(
  db: Db,
  input: {
    taskId: number;
    phase: RunPhase;
    model: string;
    cwd: string;
    worktreeId?: number | null;
    sandboxConfig?: unknown;
  }
): RunRow {
  const result = db
    .prepare(
      `INSERT INTO runs (task_id, phase, status, model, cwd, worktree_id, sandbox_config, started_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`
    )
    .run(
      input.taskId,
      input.phase,
      input.model,
      input.cwd,
      input.worktreeId ?? null,
      JSON.stringify(input.sandboxConfig ?? {}),
      nowIso()
    );
  const row = getRun(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created run");
  return row;
}

export function getRun(db: Db, id: number): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | RunRow
    | undefined;
}

export function listRuns(db: Db, taskId?: number): RunRow[] {
  if (taskId !== undefined) {
    return db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC")
      .all(taskId) as unknown as RunRow[];
  }
  return db
    .prepare("SELECT * FROM runs ORDER BY id DESC")
    .all() as unknown as RunRow[];
}

export function listRunsByStatus(db: Db, status: RunStatus): RunRow[] {
  return db
    .prepare("SELECT * FROM runs WHERE status = ?")
    .all(status) as unknown as RunRow[];
}

export function setRunStatus(
  db: Db,
  id: number,
  status: RunStatus,
  extra?: { error?: string; sdkSessionId?: string }
): void {
  const ended = ["completed", "failed", "cancelled", "interrupted"].includes(
    status
  );
  db.prepare(
    `UPDATE runs SET status = ?, error = COALESCE(?, error), sdk_session_id = COALESCE(?, sdk_session_id), ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?`
  ).run(
    status,
    extra?.error ?? null,
    extra?.sdkSessionId ?? null,
    ended ? 1 : 0,
    nowIso(),
    id
  );
}

export function setRunSdkSessionId(db: Db, id: number, sdkSessionId: string): void {
  db.prepare("UPDATE runs SET sdk_session_id = ? WHERE id = ?").run(
    sdkSessionId,
    id
  );
}
