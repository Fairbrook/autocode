import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.ts";
import { createRun } from "../db/repo/runs.ts";
import type { PlanRow, ProjectRow, RunRow, TaskRow, WorktreeRow } from "../types.ts";
import { runSession } from "./session-runner.ts";
import { loadShippedRules, compilePlanRules } from "../filter/rules.ts";
import { createFilterPreToolUseHook } from "../filter/hooks.ts";
import { recordToolEvent, updateBackgroundLeakedCount, countToolEventsByDecision, updateFilterCounts } from "../db/repo/metrics.ts";
import { listApprovedCommandRules, listApprovedNetworkDomains } from "../db/repo/plans.ts";
import { createBackgroundHooks, reconcileLiveSet, reconcileAtRunEnd } from "../background/tracker.ts";
import type { Rule } from "../filter/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPLEMENTER_SYSTEM_PROMPT = readFileSync(
  path.join(__dirname, "prompts", "implementer.md"),
  "utf8"
);
const RULES_DIR = path.join(__dirname, "..", "..", "config", "rules");

export interface RunImplementerInput {
  db: Db;
  task: TaskRow;
  project: ProjectRow;
  plan: PlanRow;
  worktree: WorktreeRow;
  /**
   * Pre-created implementation run row. The server creates it before this
   * call so that everything that happens *before* the agent starts — most
   * importantly the worktree setup command's output — streams into the same
   * run_log/SSE channel the user is already watching. Omit it and one is
   * created here (the spike scripts do this).
   */
  run?: RunRow;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /**
   * The live human-in-the-loop "ask" flow — invoked for anything the
   * filter engine couldn't resolve to allow/deny on its own. The server
   * layer (task 8) supplies the real implementation: create an
   * approval_requests row, broadcast over SSE + notifications, and park a
   * Promise until the user responds via the API.
   */
  canUseTool: CanUseTool;
  abortController?: AbortController;
}

export interface ImplementerOutcome {
  ok: boolean;
  runId: number;
  errorSummary?: string;
  backgroundLeakedCount: number;
}

export async function runImplementer(input: RunImplementerInput): Promise<ImplementerOutcome> {
  const { db, task, project, plan, worktree } = input;

  const run =
    input.run ??
    createRun(db, {
      taskId: task.id,
      phase: "implementation",
      model: input.model,
      cwd: worktree.worktree_path,
      worktreeId: worktree.id,
    });

  const shippedRules = loadShippedRules(RULES_DIR);
  const planRules: Rule[] = compilePlanRules(listApprovedCommandRules(db, plan.id));
  const allRules = [...shippedRules, ...planRules];

  const gitDir = path.join(project.repo_path, ".git");
  const writeRoots = [worktree.worktree_path, worktree.scratch_path, gitDir];
  const denyWriteRoots = [path.join(gitDir, "hooks"), path.join(gitDir, "config")];
  const projectDomains = JSON.parse(project.allowed_network_domains) as string[];
  const planDomains = listApprovedNetworkDomains(db, plan.id);
  const allowedDomains = [...new Set([...projectDomains, ...planDomains])];

  const filterHook = createFilterPreToolUseHook({
    getRules: () => allRules,
    getWriteRoots: () => writeRoots,
    getDenyWriteRoots: () => denyWriteRoots,
    getAllowedDomains: () => allowedDomains,
    onDecision: ({ toolName, toolUseId, result }) => {
      recordToolEvent(db, {
        runId: run.id,
        toolName,
        toolUseId,
        decision: result.decision,
        ruleId: result.matches[0]?.rule.id,
        layer: result.matches[0]?.rule.layer,
        reason: "reason" in result ? result.reason : undefined,
      });
    },
  });

  const bgHooks = createBackgroundHooks(db, run.id);

  const planText = renderPlanForPrompt(plan);
  const prompt = `${IMPLEMENTER_SYSTEM_PROMPT}\n\n---\n\n## Approved plan\n\n${planText}`;

  const result = await runSession({
    db,
    runId: run.id,
    phase: "implementation",
    prompt,
    cwd: worktree.worktree_path,
    model: input.model,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    permissionMode: "default",
    // NOTE: TodoWrite — the UI's progress feed — is auto-allowed by the
    // filter engine (config/rules/15-agent-state.json), NOT by listing it
    // here. A bare `allowedTools` entry shadows canUseTool entirely (the SDK
    // warns about exactly this), which would put one tool outside the
    // harness's single decision path and out of the tool_events audit trail.
    disallowedTools: ["WebFetch", "WebSearch"],
    settingSources: ["project"],
    hooks: {
      PreToolUse: [{ hooks: [filterHook] }],
      PostToolUse: [{ matcher: "Bash", hooks: [bgHooks.postToolUseBash] }],
      TaskCreated: [{ hooks: [bgHooks.taskCreated] }],
      TaskCompleted: [{ hooks: [bgHooks.taskCompleted] }],
    } as Options["hooks"],
    canUseTool: input.canUseTool,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: {
        allowLocalBinding: true,
        allowedDomains,
        strictAllowlist: true,
      },
      filesystem: {
        allowWrite: writeRoots,
      },
    },
    onBackgroundTasksChanged: (tasks) => reconcileLiveSet(db, run.id, tasks),
    abortController: input.abortController,
  });

  const backgroundLeakedCount = reconcileAtRunEnd(db, run.id);
  updateBackgroundLeakedCount(db, run.id, backgroundLeakedCount);

  const decisionCounts = countToolEventsByDecision(db, run.id);
  updateFilterCounts(db, run.id, {
    allow: decisionCounts.allow ?? 0,
    deny: decisionCounts.deny ?? 0,
    ask: decisionCounts.ask ?? 0,
  });

  return {
    ok: result.ok,
    runId: run.id,
    errorSummary: result.errorSummary,
    backgroundLeakedCount,
  };
}

function renderPlanForPrompt(plan: PlanRow): string {
  const steps = JSON.parse(plan.steps_json) as { order: number; description: string }[];
  const stepsText = steps
    .sort((a, b) => a.order - b.order)
    .map((s) => `${s.order}. ${s.description}`)
    .join("\n");
  return [
    `**Summary:** ${plan.summary}`,
    `**Category:** ${plan.task_category}`,
    `**TDD applies:** ${plan.tdd_applies ? "yes" : "no"} — ${plan.tdd_rationale}`,
    ``,
    `**Steps:**`,
    stepsText,
  ].join("\n");
}
