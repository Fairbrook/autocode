// One-off live smoke test for planner -> approve -> worktree -> implementer,
// end to end. Not part of the vitest suite. Run manually:
//   node scripts/spike-implementer.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { createProject } from "../src/db/repo/projects.ts";
import { createTask } from "../src/db/repo/tasks.ts";
import { runPlanner } from "../src/agent/planner.ts";
import { setPlanStatus, addApprovedCommandRules, addApprovedNetworkDomains } from "../src/db/repo/plans.ts";
import { createWorktreeOnDisk } from "../src/worktree/manager.ts";
import { createWorktree } from "../src/db/repo/worktrees.ts";
import { runImplementer } from "../src/agent/implementer.ts";

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "autocode-impl-spike-"));
  const db = openDb(path.join(dir, "spike.db"));

  const repoPath = path.join(process.env.HOME ?? "", ".local/share/autocode/test-repo");
  const worktreeRoot = path.join(dir, "worktrees");
  const project = createProject(db, { name: "test-repo", repoPath });
  const task = createTask(db, {
    projectId: project.id,
    title: "Add a subtract function",
    description: "Add a subtract(a, b) function with tests, following this repo's existing conventions.",
  });

  console.log("=== Planning ===");
  const plannerOutcome = await runPlanner({
    db,
    task,
    project,
    model: "opus",
    maxTurns: 20,
    maxBudgetUsd: 2,
  });
  if (!plannerOutcome.ok || !plannerOutcome.plan) {
    console.error("Planner failed:", plannerOutcome.errorSummary);
    process.exit(1);
  }
  const plan = plannerOutcome.plan;
  console.log("Plan category:", plan.task_category, "tdd_applies:", plan.tdd_applies);

  console.log("=== Approving plan (simulated human approval, auto-accepting all proposed commands/domains) ===");
  const proposedCommands = JSON.parse(plan.proposed_commands_json) as { pattern: string; category: string }[];
  const proposedDomains = JSON.parse(plan.proposed_domains_json) as { domain: string }[];
  addApprovedCommandRules(
    db,
    plan.id,
    proposedCommands.map((c) => ({ pattern: c.pattern, category: c.category, origin: "proposed" as const }))
  );
  addApprovedNetworkDomains(
    db,
    plan.id,
    proposedDomains.map((d) => ({ domain: d.domain, origin: "proposed" as const }))
  );
  setPlanStatus(db, plan.id, "approved", "auto-approved by spike script");
  console.log("Approved commands:", proposedCommands.map((c) => c.pattern));
  console.log("Approved domains:", proposedDomains.map((d) => d.domain));

  console.log("=== Creating worktree ===");
  const wt = createWorktreeOnDisk({
    repoPath: project.repo_path,
    taskId: task.id,
    taskTitle: task.title,
    baseRef: project.default_base_ref,
    worktreeRoot,
  });
  const worktree = createWorktree(db, {
    taskId: task.id,
    repoPath: project.repo_path,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    baseRef: project.default_base_ref,
    baseSha: wt.baseSha,
    scratchPath: wt.scratchPath,
  });
  console.log("Worktree:", worktree.worktree_path, "branch:", worktree.branch);

  console.log("=== Implementing ===");
  let askCount = 0;
  const outcome = await runImplementer({
    db,
    task,
    project,
    plan,
    worktree,
    model: "sonnet",
    maxTurns: 60,
    maxBudgetUsd: 5,
    canUseTool: async (toolName, toolInput, opts) => {
      askCount += 1;
      console.log(`[ASK #${askCount}] ${toolName}:`, JSON.stringify(toolInput).slice(0, 200), "| title:", opts.title);
      // Spike-only stub: auto-approve everything that reaches canUseTool, to
      // exercise the full path without blocking on a human. The real
      // implementation (task 8) parks on an actual approval_requests row.
      return { behavior: "allow" };
    },
  });

  console.log("=== Result ===");
  console.log("ok:", outcome.ok);
  console.log("errorSummary:", outcome.errorSummary);
  console.log("backgroundLeakedCount:", outcome.backgroundLeakedCount);
  console.log("total canUseTool asks:", askCount);

  const { execFileSync } = await import("node:child_process");
  console.log("=== git log on worktree branch ===");
  console.log(execFileSync("git", ["log", "--oneline", worktree.branch], { cwd: repoPath, encoding: "utf8" }));
  console.log("=== git status --porcelain on MAIN checkout (must be empty) ===");
  const mainStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" });
  console.log(JSON.stringify(mainStatus));
  console.log("=== git diff --stat on worktree ===");
  console.log(execFileSync("git", ["diff", "--stat", worktree.base_sha], { cwd: worktree.worktree_path, encoding: "utf8" }));
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
