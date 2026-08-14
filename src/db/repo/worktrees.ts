import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { WorktreeRow, WorktreeSetupStatus, WorktreeStatus } from "../../types.ts";

export function createWorktree(
  db: Db,
  input: {
    taskId: number;
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    baseSha: string;
    scratchPath: string;
  }
): WorktreeRow {
  const result = db
    .prepare(
      `INSERT INTO worktrees (task_id, repo_path, worktree_path, branch, base_ref, base_sha, scratch_path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`
    )
    .run(
      input.taskId,
      input.repoPath,
      input.worktreePath,
      input.branch,
      input.baseRef,
      input.baseSha,
      input.scratchPath,
      nowIso()
    );
  const row = getWorktree(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created worktree");
  return row;
}

export function getWorktree(db: Db, id: number): WorktreeRow | undefined {
  return db.prepare("SELECT * FROM worktrees WHERE id = ?").get(id) as
    | WorktreeRow
    | undefined;
}

export function countWorktreesForTask(db: Db, taskId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) as n FROM worktrees WHERE task_id = ?")
    .get(taskId) as { n: number };
  return row.n;
}

/** Every worktree ever created for a task, newest first — including removed ones. */
export function listWorktreesForTask(db: Db, taskId: number): WorktreeRow[] {
  return db
    .prepare("SELECT * FROM worktrees WHERE task_id = ? ORDER BY id DESC")
    .all(taskId) as unknown as WorktreeRow[];
}

export function listWorktrees(db: Db): WorktreeRow[] {
  return db
    .prepare("SELECT * FROM worktrees ORDER BY id DESC")
    .all() as unknown as WorktreeRow[];
}

export function setWorktreeStatus(
  db: Db,
  id: number,
  status: WorktreeStatus
): void {
  const removed = status === "removed";
  db.prepare(
    `UPDATE worktrees SET status = ?, removed_at = CASE WHEN ? THEN ? ELSE removed_at END WHERE id = ?`
  ).run(status, removed ? 1 : 0, nowIso(), id);
}

/**
 * Records the resolved setup command on the worktree row as it starts. The
 * command is copied here (rather than only read back from the project) so
 * the record of what actually ran in this worktree survives later edits to
 * projects.json / the project row.
 */
export function markWorktreeSetupStarted(db: Db, id: number, command: string): void {
  db.prepare(
    `UPDATE worktrees
        SET setup_command = ?, setup_status = 'running', setup_started_at = ?,
            setup_ended_at = NULL, setup_exit_code = NULL, setup_output = NULL
      WHERE id = ?`
  ).run(command, nowIso(), id);
}

export function markWorktreeSetupFinished(
  db: Db,
  id: number,
  result: { status: WorktreeSetupStatus; exitCode: number | null; output: string }
): void {
  db.prepare(
    `UPDATE worktrees
        SET setup_status = ?, setup_exit_code = ?, setup_output = ?, setup_ended_at = ?
      WHERE id = ?`
  ).run(result.status, result.exitCode, result.output, nowIso(), id);
}

/**
 * Records that this worktree's branch was merged into the main checkout.
 * Status moves to 'retained': the worktree is still on disk (the user may
 * want to keep poking at it) but it is no longer the live workspace for the
 * task, and re-merging it would be a no-op.
 */
export function markWorktreeMerged(
  db: Db,
  id: number,
  result: { mergeCommit: string; targetBranch: string }
): void {
  db.prepare(
    `UPDATE worktrees
        SET status = 'retained', merged_at = ?, merge_commit = ?, merge_target_branch = ?
      WHERE id = ?`
  ).run(nowIso(), result.mergeCommit, result.targetBranch, id);
}

/** Worktrees whose setup was still 'running' when the process died — used by boot reconciliation. */
export function listWorktreesBySetupStatus(
  db: Db,
  status: WorktreeSetupStatus
): WorktreeRow[] {
  return db
    .prepare("SELECT * FROM worktrees WHERE setup_status = ?")
    .all(status) as unknown as WorktreeRow[];
}
