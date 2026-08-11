import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.ts";
import { createProject } from "../../src/db/repo/projects.ts";
import { createTask } from "../../src/db/repo/tasks.ts";
import { createRun } from "../../src/db/repo/runs.ts";
import { createPlan, addApprovedCommandRules, listApprovedCommandRules } from "../../src/db/repo/plans.ts";
import { createWorktree } from "../../src/db/repo/worktrees.ts";
import { createApprovalRequest, resolveApprovalRequest, listPendingApprovals } from "../../src/db/repo/approvals.ts";
import { upsertBackgroundTaskStarted, markBackgroundTaskStatus, listRunningBackgroundTasks } from "../../src/db/repo/background.ts";
import { upsertMetrics, recordToolEvent, countToolEventsByDecision } from "../../src/db/repo/metrics.ts";
import { appendRunLog, listRunLogSince } from "../../src/db/repo/log.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "autocode-db-test-"));
  db = openDb(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("db layer smoke test", () => {
  it("supports the full entity graph for one task", () => {
    const project = createProject(db, { name: "demo", repoPath: "/tmp/demo-repo" });
    const task = createTask(db, {
      projectId: project.id,
      title: "add subtract fn",
      description: "add a subtract function with tests",
    });

    const planningRun = createRun(db, {
      taskId: task.id,
      phase: "planning",
      model: "opus",
      cwd: project.repo_path,
    });

    const plan = createPlan(db, {
      taskId: task.id,
      runId: planningRun.id,
      summary: "Add subtract()",
      taskCategory: "feature",
      tddApplies: true,
      tddRationale: "new behavior needs a failing test first",
      steps: [{ order: 1, description: "write failing test" }],
      proposedCommands: [{ pattern: "pnpm vitest run", why: "run tests", category: "build-test" }],
      proposedDomains: [],
      risks: [],
      files: ["src/subtract.ts"],
      rawOutput: { ok: true },
    });
    expect(plan.status).toBe("pending");

    addApprovedCommandRules(db, plan.id, [
      { pattern: "pnpm vitest run", category: "build-test", origin: "proposed" },
      { pattern: "frobnicate", category: undefined, origin: "user_added" },
    ]);
    const rules = listApprovedCommandRules(db, plan.id);
    expect(rules.map((r) => r.pattern)).toEqual(["pnpm vitest run", "frobnicate"]);

    const worktree = createWorktree(db, {
      taskId: task.id,
      repoPath: project.repo_path,
      worktreePath: "/tmp/demo-wt",
      branch: "autocode/demo-1",
      baseRef: "HEAD",
      baseSha: "deadbeef",
      scratchPath: "/tmp/demo-scratch",
    });

    const implRun = createRun(db, {
      taskId: task.id,
      phase: "implementation",
      model: "sonnet",
      cwd: worktree.worktree_path,
      worktreeId: worktree.id,
    });

    // Approval flow
    const approval = createApprovalRequest(db, {
      runId: implRun.id,
      toolUseId: "toolu_1",
      toolName: "Bash",
      title: "Claude wants to run curl https://example.com",
      toolInput: { command: "curl https://example.com" },
      reason: "non-loopback network target",
      blockedPath: null,
    });
    expect(listPendingApprovals(db, implRun.id)).toHaveLength(1);
    resolveApprovalRequest(db, approval.id, "denied", { note: "not needed" });
    expect(listPendingApprovals(db, implRun.id)).toHaveLength(0);

    // Background task tracking
    upsertBackgroundTaskStarted(db, {
      runId: implRun.id,
      sdkTaskId: "task_abc",
      taskType: "bash_background",
      command: "pnpm dev",
    });
    expect(listRunningBackgroundTasks(db, implRun.id)).toHaveLength(1);
    markBackgroundTaskStatus(db, implRun.id, "task_abc", "leaked", {
      stopAttempted: true,
      stopResult: "killed via TaskStop",
    });
    expect(listRunningBackgroundTasks(db, implRun.id)).toHaveLength(0);

    // tool_events + metrics
    recordToolEvent(db, { runId: implRun.id, toolName: "Bash", decision: "allow", ruleId: "30-build-test" });
    recordToolEvent(db, { runId: implRun.id, toolName: "Bash", decision: "deny", ruleId: "00-hard-deny" });
    recordToolEvent(db, { runId: implRun.id, toolName: "Bash", decision: "ask" });
    const counts = countToolEventsByDecision(db, implRun.id);
    expect(counts).toEqual({ allow: 1, deny: 1, ask: 1 });

    const metrics = upsertMetrics(db, {
      runId: implRun.id,
      phase: "implementation",
      resultSubtype: "success",
      totalCostUsd: 0.42,
      filterAllowCount: counts.allow,
      filterDenyCount: counts.deny,
      filterAskCount: counts.ask,
      backgroundLeakedCount: 1,
    });
    expect(metrics.total_cost_usd).toBeCloseTo(0.42);
    expect(metrics.background_leaked_count).toBe(1);

    // run_log + replay cursor
    const e1 = appendRunLog(db, implRun.id, "status", { status: "running" });
    const e2 = appendRunLog(db, implRun.id, "log", { text: "hello" });
    const replay = listRunLogSince(db, implRun.id, e1.seq);
    expect(replay.map((r) => r.id)).toEqual([e2.id]);
  });
});
