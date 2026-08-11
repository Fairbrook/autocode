import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { MetricsRow, RunPhase } from "../../types.ts";

export interface MetricsInput {
  runId: number;
  phase: RunPhase;
  resultSubtype?: string | null;
  isError?: boolean | null;
  stopReason?: string | null;
  durationMs?: number | null;
  durationApiMs?: number | null;
  numTurns?: number | null;
  totalCostUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  modelUsage?: unknown;
  toolCallCounts?: Record<string, number>;
  filterAllowCount?: number;
  filterDenyCount?: number;
  filterAskCount?: number;
  sdkPermissionDenials?: number;
  backgroundLeakedCount?: number;
}

export function upsertMetrics(db: Db, input: MetricsInput): MetricsRow {
  db.prepare(
    `INSERT INTO metrics (
      run_id, phase, result_subtype, is_error, stop_reason, duration_ms, duration_api_ms, num_turns,
      total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      model_usage_json, tool_call_counts_json, filter_allow_count, filter_deny_count, filter_ask_count,
      sdk_permission_denials, background_leaked_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      result_subtype = excluded.result_subtype,
      is_error = excluded.is_error,
      stop_reason = excluded.stop_reason,
      duration_ms = excluded.duration_ms,
      duration_api_ms = excluded.duration_api_ms,
      num_turns = excluded.num_turns,
      total_cost_usd = excluded.total_cost_usd,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      model_usage_json = excluded.model_usage_json,
      tool_call_counts_json = excluded.tool_call_counts_json,
      filter_allow_count = excluded.filter_allow_count,
      filter_deny_count = excluded.filter_deny_count,
      filter_ask_count = excluded.filter_ask_count,
      sdk_permission_denials = excluded.sdk_permission_denials,
      background_leaked_count = excluded.background_leaked_count`
  ).run(
    input.runId,
    input.phase,
    input.resultSubtype ?? null,
    input.isError === undefined || input.isError === null ? null : input.isError ? 1 : 0,
    input.stopReason ?? null,
    input.durationMs ?? null,
    input.durationApiMs ?? null,
    input.numTurns ?? null,
    input.totalCostUsd ?? null,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    input.cacheReadTokens ?? null,
    input.cacheCreationTokens ?? null,
    JSON.stringify(input.modelUsage ?? null),
    JSON.stringify(input.toolCallCounts ?? {}),
    input.filterAllowCount ?? 0,
    input.filterDenyCount ?? 0,
    input.filterAskCount ?? 0,
    input.sdkPermissionDenials ?? 0,
    input.backgroundLeakedCount ?? 0,
    nowIso()
  );
  const row = getMetricsForRun(db, input.runId);
  if (!row) throw new Error("failed to read back upserted metrics");
  return row;
}

/**
 * Patches just the background-leak count in after the fact — reconciliation
 * runs after the query() loop (and therefore after the metrics row from the
 * final `result` message) completes, so this can't be folded into the
 * initial upsertMetrics call.
 */
export function updateBackgroundLeakedCount(db: Db, runId: number, count: number): void {
  db.prepare(
    "UPDATE metrics SET background_leaked_count = ? WHERE run_id = ?"
  ).run(count, runId);
}

/**
 * Patches the filter allow/deny/ask counts in after the fact, same reason
 * as updateBackgroundLeakedCount: the filter engine's decisions accumulate
 * in tool_events throughout the run, but the metrics row is written from
 * the SDK's final `result` message, which has no knowledge of the harness's
 * own filter — so this has to be a separate pass after the run completes.
 */
export function updateFilterCounts(
  db: Db,
  runId: number,
  counts: { allow: number; deny: number; ask: number }
): void {
  db.prepare(
    "UPDATE metrics SET filter_allow_count = ?, filter_deny_count = ?, filter_ask_count = ? WHERE run_id = ?"
  ).run(counts.allow, counts.deny, counts.ask, runId);
}

export function getMetricsForRun(db: Db, runId: number): MetricsRow | undefined {
  return db.prepare("SELECT * FROM metrics WHERE run_id = ?").get(runId) as
    | MetricsRow
    | undefined;
}

export function listMetrics(db: Db): (MetricsRow & { task_id: number })[] {
  // Joined with runs for task_id so the UI can link a history row back to
  // its task (metrics alone only knows run_id).
  return db
    .prepare(
      `SELECT metrics.*, runs.task_id as task_id
       FROM metrics JOIN runs ON runs.id = metrics.run_id
       ORDER BY metrics.id DESC`
    )
    .all() as unknown as (MetricsRow & { task_id: number })[];
}

export function recordToolEvent(
  db: Db,
  input: {
    runId: number;
    toolName: string;
    toolUseId?: string | null;
    decision: "allow" | "deny" | "ask" | "passthrough";
    ruleId?: string | null;
    layer?: string | null;
    segment?: string | null;
    reason?: string | null;
    durationMs?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO tool_events (run_id, ts, tool_name, tool_use_id, decision, rule_id, layer, segment, reason, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    nowIso(),
    input.toolName,
    input.toolUseId ?? null,
    input.decision,
    input.ruleId ?? null,
    input.layer ?? null,
    input.segment ?? null,
    input.reason ?? null,
    input.durationMs ?? null
  );
}

export function countToolEventsByDecision(
  db: Db,
  runId: number
): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT decision, COUNT(*) as n FROM tool_events WHERE run_id = ? GROUP BY decision"
    )
    .all(runId) as unknown as { decision: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.decision] = r.n;
  return out;
}
