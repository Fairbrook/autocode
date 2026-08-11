import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type {
  ApprovalRequestRow,
  ApprovalStatus,
  RememberScope,
} from "../../types.ts";

export function createApprovalRequest(
  db: Db,
  input: {
    runId: number;
    toolUseId: string | null;
    toolName: string;
    title: string | null;
    toolInput: unknown;
    reason: string | null;
    blockedPath: string | null;
  }
): ApprovalRequestRow {
  const result = db
    .prepare(
      `INSERT INTO approval_requests (run_id, tool_use_id, tool_name, title, tool_input_json, reason, blocked_path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      input.runId,
      input.toolUseId,
      input.toolName,
      input.title,
      JSON.stringify(input.toolInput),
      input.reason,
      input.blockedPath,
      nowIso()
    );
  const row = getApprovalRequest(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created approval request");
  return row;
}

export function getApprovalRequest(
  db: Db,
  id: number
): ApprovalRequestRow | undefined {
  return db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as
    | ApprovalRequestRow
    | undefined;
}

export function listPendingApprovals(
  db: Db,
  runId?: number
): ApprovalRequestRow[] {
  if (runId !== undefined) {
    return db
      .prepare(
        "SELECT * FROM approval_requests WHERE status = 'pending' AND run_id = ? ORDER BY id"
      )
      .all(runId) as unknown as ApprovalRequestRow[];
  }
  return db
    .prepare("SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY id")
    .all() as unknown as ApprovalRequestRow[];
}

export function resolveApprovalRequest(
  db: Db,
  id: number,
  status: Exclude<ApprovalStatus, "pending">,
  opts?: { rememberScope?: RememberScope; note?: string }
): void {
  db.prepare(
    `UPDATE approval_requests SET status = ?, remember_scope = COALESCE(?, remember_scope), resolution_note = ?, resolved_at = ? WHERE id = ?`
  ).run(status, opts?.rememberScope ?? null, opts?.note ?? null, nowIso(), id);
}

/** Boot-time reconciliation: any request still 'pending' from a previous process lifetime is orphaned. */
export function expireOrphanedPendingApprovals(db: Db): number {
  const result = db
    .prepare(
      `UPDATE approval_requests SET status = 'expired', resolved_at = ?, resolution_note = 'orphaned by server restart' WHERE status = 'pending'`
    )
    .run(nowIso());
  return Number(result.changes);
}
