import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { RunLogRow } from "../../types.ts";
import { broadcastRunLog } from "../../notify/sse.ts";

/**
 * `seq` is just the table's own autoincrement id, reused as the SSE
 * replay/Last-Event-ID cursor — globally monotonic across all runs and
 * process restarts, so there's no separate counter to keep in memory or
 * lose on a crash.
 */
export function appendRunLog(
  db: Db,
  runId: number,
  kind: string,
  payload: unknown
): RunLogRow {
  const result = db
    .prepare(
      "INSERT INTO run_log (run_id, ts, seq, kind, payload_json) VALUES (?, ?, 0, ?, ?)"
    )
    .run(runId, nowIso(), kind, JSON.stringify(payload));
  const id = Number(result.lastInsertRowid);
  db.prepare("UPDATE run_log SET seq = ? WHERE id = ?").run(id, id);
  const row = db
    .prepare("SELECT * FROM run_log WHERE id = ?")
    .get(id) as RunLogRow | undefined;
  if (!row) throw new Error("failed to read back appended run log entry");
  broadcastRunLog(row.run_id, row.seq, row.kind, JSON.parse(row.payload_json));
  return row;
}

export function listRunLogSince(
  db: Db,
  runId: number,
  sinceSeq: number
): RunLogRow[] {
  return db
    .prepare(
      "SELECT * FROM run_log WHERE run_id = ? AND seq > ? ORDER BY seq"
    )
    .all(runId, sinceSeq) as unknown as RunLogRow[];
}

export function listRunLog(db: Db, runId: number): RunLogRow[] {
  return db
    .prepare("SELECT * FROM run_log WHERE run_id = ? ORDER BY seq")
    .all(runId) as unknown as RunLogRow[];
}
