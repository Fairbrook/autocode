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
  const localServiceHosts = JSON.parse(project.local_service_hosts || "[]") as string[];
  // Local service hosts are merged in rather than required separately: the
  // sandbox proxy enforces this allowlist for a host-local target exactly as
  // it does for an external domain (an undeclared one gets a 403), so routing
  // a host to the proxy without allowing it would only swap one connection
  // failure for another. See src/filter/proxy-env.ts.
  const allowedDomains = [...new Set([...projectDomains, ...planDomains, ...localServiceHosts])];
  const allowUnsandboxedCommands = project.allow_unsandboxed_commands === 1;

  const filterHook = createFilterPreToolUseHook({
    getRules: () => allRules,
    getWriteRoots: () => writeRoots,
    getDenyWriteRoots: () => denyWriteRoots,
    getAllowedDomains: () => allowedDomains,
    getLocalServiceHosts: () => localServiceHosts,
    getUnsandboxedCommandsAllowed: () => allowUnsandboxedCommands,
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
    // TaskCreated/TaskCompleted are deliberately absent: they carry the
    // agent's task list, not background processes, and runSession registers
    // its own handlers for them (src/agent/todos.ts).
    hooks: {
      PreToolUse: [{ hooks: [filterHook] }],
      PostToolUse: [{ matcher: "Bash", hooks: [bgHooks.postToolUseBash] }],
    } as Options["hooks"],
    canUseTool: input.canUseTool,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // Per-project escape hatch. False (the default) makes the SDK ignore
      // `dangerouslyDisableSandbox` entirely, so the filter engine's
      // sandboxOverride rules stay inert and every command is kernel-sandboxed.
      // True hands build/test, dev-server, playwright and container commands
      // to the harness filter alone — the only way a project whose tests speak
      // raw postgres (or run on Node < 24) can reach its own dev services.
      // See the 006 migration and docs/SANDBOX-FINDINGS.md.
      allowUnsandboxedCommands,
      network: {
        allowLocalBinding: true,
        allowedDomains,
        strictAllowlist: true,
        // `docker`/`podman` are clients, not runtimes: everything they do goes
        // over /var/run/docker.sock, and the sandbox blocks AF_UNIX connect()
        // unless this is set. It is all-or-nothing on Linux (seccomp cannot
        // filter sockets by path), so the grant is per-project and off by
        // default — see docs/SANDBOX-FINDINGS.md for what it costs.
        ...(project.allow_docker_socket ? { allowAllUnixSockets: true } : {}),
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
  const risks = JSON.parse(plan.risks_json || "[]") as string[];
  const files = JSON.parse(plan.files_json || "[]") as string[];

  return [
    `**Summary:** ${plan.summary}`,
    `**Category:** ${plan.task_category}`,
    `**TDD applies:** ${plan.tdd_applies ? "yes" : "no"} — ${plan.tdd_rationale}`,
    ``,
    `**Steps:**`,
    stepsText,
    // Risks and files are editable in the review UI, so they have to reach
    // the agent — an edit box whose contents go nowhere is worse than no
    // edit box. The human's version of these is the authoritative one by
    // the time a plan is approved.
    ...(risks.length ? [``, `**Risks called out during review:**`, ...risks.map((r) => `- ${r}`)] : []),
    ...(files.length
      ? [``, `**Files expected to change:** ${files.join(", ")}`]
      : []),
    ...(plan.source === "user_edit"
      ? [
          ``,
          `Note: this plan was edited by the user after the planning agent wrote it${
            plan.edit_note ? ` — "${plan.edit_note}"` : ""
          }. Where the edits and the original approach differ, the edits win.`,
        ]
      : []),
  ].join("\n");
}
