import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type {
  PlanRow,
  PlanStatus,
  ProposedCommandJson,
  ProposedDomainJson,
} from "../../types.ts";

export interface PlanInput {
  taskId: number;
  runId: number;
  summary: string;
  taskCategory: string;
  tddApplies: boolean;
  tddRationale: string;
  steps: { order: number; description: string }[];
  proposedCommands: ProposedCommandJson[];
  proposedDomains: ProposedDomainJson[];
  risks: string[];
  files: string[];
  rawOutput: unknown;
}

export function createPlan(db: Db, input: PlanInput): PlanRow {
  const result = db
    .prepare(
      `INSERT INTO plans (
        task_id, run_id, version, summary, task_category, tdd_applies, tdd_rationale,
        steps_json, proposed_commands_json, proposed_domains_json, risks_json, files_json,
        raw_output_json, status
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(
      input.taskId,
      input.runId,
      input.summary,
      input.taskCategory,
      input.tddApplies ? 1 : 0,
      input.tddRationale,
      JSON.stringify(input.steps),
      JSON.stringify(input.proposedCommands),
      JSON.stringify(input.proposedDomains),
      JSON.stringify(input.risks),
      JSON.stringify(input.files),
      JSON.stringify(input.rawOutput)
    );
  const row = getPlan(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created plan");
  return row;
}

export interface PlanRevisionInput {
  summary: string;
  taskCategory: string;
  tddApplies: boolean;
  tddRationale: string;
  steps: { order: number; description: string }[];
  proposedCommands: ProposedCommandJson[];
  proposedDomains: ProposedDomainJson[];
  risks: string[];
  files: string[];
  note?: string;
}

/**
 * Writes a human-edited version of `base` and supersedes it, in one
 * transaction so a task can never end up with two live plans.
 *
 * The new row keeps the original's `run_id`: the planning run is still where
 * this plan came from, and there's no run of its own to point at. `source`
 * and `supersedes_plan_id` are what distinguish it from what the model
 * actually proposed. `raw_output_json` deliberately keeps the planner's
 * original output rather than the edited values — it's the record of what
 * the model said, and overwriting it would erase the only copy.
 */
export function createPlanRevision(
  db: Db,
  base: PlanRow,
  input: PlanRevisionInput
): PlanRow {
  db.exec("BEGIN");
  try {
    const result = db
      .prepare(
        `INSERT INTO plans (
          task_id, run_id, version, summary, task_category, tdd_applies, tdd_rationale,
          steps_json, proposed_commands_json, proposed_domains_json, risks_json, files_json,
          raw_output_json, status, source, edit_note, supersedes_plan_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'user_edit', ?, ?)`
      )
      .run(
        base.task_id,
        base.run_id,
        base.version + 1,
        input.summary,
        input.taskCategory,
        input.tddApplies ? 1 : 0,
        input.tddRationale,
        JSON.stringify(input.steps),
        JSON.stringify(input.proposedCommands),
        JSON.stringify(input.proposedDomains),
        JSON.stringify(input.risks),
        JSON.stringify(input.files),
        base.raw_output_json,
        input.note ?? null,
        base.id
      );
    db.prepare("UPDATE plans SET status = 'superseded' WHERE id = ?").run(base.id);
    db.exec("COMMIT");
    const row = getPlan(db, Number(result.lastInsertRowid));
    if (!row) throw new Error("failed to read back plan revision");
    return row;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Every version of a task's plan, oldest first — the edit history. */
export function listPlanVersions(db: Db, taskId: number): PlanRow[] {
  return db
    .prepare("SELECT * FROM plans WHERE task_id = ? ORDER BY version, id")
    .all(taskId) as unknown as PlanRow[];
}

export function getPlan(db: Db, id: number): PlanRow | undefined {
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as
    | PlanRow
    | undefined;
}

export function getPlanForTask(db: Db, taskId: number): PlanRow | undefined {
  return db
    .prepare("SELECT * FROM plans WHERE task_id = ? ORDER BY id DESC LIMIT 1")
    .get(taskId) as PlanRow | undefined;
}

export function setPlanStatus(
  db: Db,
  id: number,
  status: PlanStatus,
  note?: string
): void {
  const approved = status === "approved";
  db.prepare(
    `UPDATE plans SET status = ?, approval_note = ?, approved_at = CASE WHEN ? THEN ? ELSE approved_at END WHERE id = ?`
  ).run(status, note ?? null, approved ? 1 : 0, nowIso(), id);
}

export function addApprovedCommandRules(
  db: Db,
  planId: number,
  rules: { pattern: string; category?: string; note?: string; origin: "proposed" | "user_added" }[]
): void {
  const insert = db.prepare(
    `INSERT INTO approved_command_rules (plan_id, pattern, category, note, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const ts = nowIso();
  for (const rule of rules) {
    insert.run(
      planId,
      rule.pattern,
      rule.category ?? null,
      rule.note ?? null,
      rule.origin,
      ts
    );
  }
}

export function listApprovedCommandRules(
  db: Db,
  planId: number
): { pattern: string; category: string | null; note: string | null; origin: string }[] {
  return db
    .prepare(
      "SELECT pattern, category, note, origin FROM approved_command_rules WHERE plan_id = ?"
    )
    .all(planId) as unknown as {
    pattern: string;
    category: string | null;
    note: string | null;
    origin: string;
  }[];
}

export function addApprovedNetworkDomains(
  db: Db,
  planId: number,
  domains: { domain: string; note?: string; origin: "proposed" | "user_added" }[]
): void {
  const insert = db.prepare(
    `INSERT INTO approved_network_domains (plan_id, domain, note, origin, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  const ts = nowIso();
  for (const d of domains) {
    insert.run(planId, d.domain, d.note ?? null, d.origin, ts);
  }
}

export function listApprovedNetworkDomains(db: Db, planId: number): string[] {
  const rows = db
    .prepare("SELECT domain FROM approved_network_domains WHERE plan_id = ?")
    .all(planId) as unknown as { domain: string }[];
  return rows.map((r) => r.domain);
}
