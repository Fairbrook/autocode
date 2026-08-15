import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/index.ts";
import { createRun } from "../db/repo/runs.ts";
import { createPlan } from "../db/repo/plans.ts";
import type { ProjectRow, TaskRow } from "../types.ts";
import { runSession } from "./session-runner.ts";
import { PlanOutputSchema, PlanOutputJsonSchema } from "./plan-schema.ts";
import type { PlanRow } from "../types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLANNER_SYSTEM_PROMPT = readFileSync(
  path.join(__dirname, "prompts", "planner.md"),
  "utf8"
);

export interface RunPlannerInput {
  db: Db;
  task: TaskRow;
  project: ProjectRow;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /**
   * Built per run rather than passed ready-made: the run row this planner
   * writes to is created below, and an approval has to be filed against it to
   * be answerable from the task page.
   *
   * Planning is read-only and its Bash calls are auto-allowed by the sandbox,
   * so in practice the only thing that reaches this callback is the agent
   * asking the user a question (AskUserQuestion) — which it could not do at
   * all while the planner had no permission callback.
   */
  makeCanUseTool?: (runId: number) => CanUseTool;
}

export interface PlannerOutcome {
  ok: boolean;
  plan?: PlanRow;
  errorSummary?: string;
}

/**
 * Runs the read-only planning agent against the MAIN checkout (never a
 * worktree — no worktree exists yet at this point). permissionMode: 'plan'
 * is CLI-enforced read-only (not just prompted), and disallowedTools
 * removes Write/Edit/NotebookEdit/WebFetch/WebSearch from the model's tool
 * set entirely as a second, independent guarantee.
 */
export async function runPlanner(input: RunPlannerInput): Promise<PlannerOutcome> {
  const { db, task, project } = input;

  const run = createRun(db, {
    taskId: task.id,
    phase: "planning",
    model: input.model,
    cwd: project.repo_path,
  });

  const canUseTool = input.makeCanUseTool?.(run.id);

  const prompt = `${PLANNER_SYSTEM_PROMPT}\n\n---\n\nTask description from the user:\n\n${task.description}`;

  const result = await runSession({
    db,
    runId: run.id,
    phase: "planning",
    prompt,
    cwd: project.repo_path,
    model: input.model,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    permissionMode: "plan",
    disallowedTools: ["Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
    ...(canUseTool ? { canUseTool } : {}),
    outputFormat: { type: "json_schema", schema: PlanOutputJsonSchema },
    settingSources: ["project"],
  });

  if (!result.ok) {
    return { ok: false, errorSummary: result.errorSummary };
  }

  const parsed = PlanOutputSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    return {
      ok: false,
      errorSummary: `Planner returned output that didn't match the plan schema: ${parsed.error.message}`,
    };
  }

  const plan = createPlan(db, {
    taskId: task.id,
    runId: run.id,
    summary: parsed.data.summary,
    taskCategory: parsed.data.task_category,
    tddApplies: parsed.data.tdd_applies,
    tddRationale: parsed.data.tdd_rationale,
    steps: parsed.data.steps,
    proposedCommands: parsed.data.proposed_commands,
    proposedDomains: parsed.data.proposed_domains,
    risks: parsed.data.risks,
    files: parsed.data.files,
    rawOutput: result.structuredOutput,
  });

  return { ok: true, plan };
}
