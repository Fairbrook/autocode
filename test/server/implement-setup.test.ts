import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server/index.ts";
import type { Db } from "../../src/db/index.ts";
import { createProject } from "../../src/db/repo/projects.ts";
import { createTask, getTask } from "../../src/db/repo/tasks.ts";
import { createRun, getRun } from "../../src/db/repo/runs.ts";
import { createPlan, setPlanStatus } from "../../src/db/repo/plans.ts";
import { getWorktree, listWorktrees } from "../../src/db/repo/worktrees.ts";
import { listRunLog } from "../../src/db/repo/log.ts";
import { loginAs } from "../helpers/auth.ts";
import { writeTestConfig } from "../helpers/server.ts";

let base: string;
let repoPath: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let db: Db;
/** Every call the stand-in implementation agent received, in order. */
let agentCalls: { runId: number; worktreePath: string; taskStatus: string | undefined }[];
/** Session cookie for the test account — every request below is authenticated. */
let auth: Record<string, string>;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function approvedPlanFor(project: { id: number; repo_path: string }) {
  const task = createTask(db, {
    projectId: project.id,
    title: "add subtract",
    description: "add a subtract function",
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
    tddRationale: "new behavior",
    steps: [{ order: 1, description: "write failing test" }],
    proposedCommands: [],
    proposedDomains: [],
    risks: [],
    files: [],
    rawOutput: {},
  });
  setPlanStatus(db, plan.id, "approved");
  return { task, plan };
}

/** Polls until `predicate` holds — the implement endpoint returns 202 and finishes the work in the background. */
async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for the background pipeline");
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-server-test-"));
  repoPath = path.join(base, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(["init", "-q", "."], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "."], repoPath);
  git(["commit", "-q", "-m", "initial"], repoPath);

  const { configPath, projectsPath } = writeTestConfig(base);
  agentCalls = [];
  server = await buildServer({
    configPath,
    projectsPath,
    // Stand-in for the real agent: these tests are about what happens
    // before it starts, and a live model call has no place in the suite.
    runAgent: async (input) => {
      agentCalls.push({
        runId: input.run!.id,
        worktreePath: input.worktree.worktree_path,
        taskStatus: getTask(db, input.task.id)?.status,
      });
      return { ok: true, runId: input.run!.id, backgroundLeakedCount: 0 };
    },
  });
  db = server.db;
  auth = (await loginAs(server.app, db)).headers;
});

afterEach(async () => {
  await server.app.close();
  rmSync(base, { recursive: true, force: true });
});

describe("POST /api/plans/:id/implement — worktree setup", () => {
  it("runs the project's setup command in the new worktree before the agent starts", async () => {
    const project = createProject(db, {
      name: "demo",
      repoPath,
      // Stands in for `pnpm install`: proves the command runs in the
      // worktree (not the main checkout) and that its output is captured.
      // The sleep makes the "parked in setting_up" window observable rather
      // than a race against a command that finishes in microseconds.
      setupCommand: "echo installing-deps && sleep 0.4 && echo ok > .setup-ran",
    });
    const { task, plan } = approvedPlanFor(project);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/implement`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);
    const bodyRun = res.json().run;
    expect(bodyRun.id).toBeGreaterThan(0);

    // The task parks in 'setting_up' while dependencies install — and the
    // agent has not been handed the worktree yet.
    expect(getTask(db, task.id)?.status).toBe("setting_up");
    expect(agentCalls).toHaveLength(0);

    await waitFor(() => getTask(db, task.id)?.status === "done");

    const worktree = listWorktrees(db)[0]!;
    expect(worktree.setup_status).toBe("succeeded");
    expect(worktree.setup_exit_code).toBe(0);
    expect(worktree.setup_command).toBe(
      "echo installing-deps && sleep 0.4 && echo ok > .setup-ran"
    );
    expect(worktree.setup_output).toContain("installing-deps");

    // Ran inside the worktree, leaving the main checkout untouched.
    expect(git(["status", "--porcelain"], repoPath)).toBe("");
    expect(git(["status", "--porcelain"], worktree.worktree_path)).toContain(".setup-ran");

    // Only then does the agent get the worktree — on the same run row, so
    // setup output and agent output share one live channel.
    expect(agentCalls).toEqual([
      { runId: bodyRun.id, worktreePath: worktree.worktree_path, taskStatus: "implementing" },
    ]);

    // Setup progress is on the same run_log/SSE channel as the agent's own
    // output, so the UI has something to show from the first second.
    const kinds = listRunLog(db, bodyRun.id).map((r) => r.kind);
    expect(kinds).toContain("setup_status");
    expect(kinds).toContain("setup_output");
  });

  it("goes straight to the agent when the project configures no setup command", async () => {
    const project = createProject(db, { name: "demo", repoPath, setupCommand: null });
    const { task, plan } = approvedPlanFor(project);

    await server.app.inject({ method: "POST", url: `/api/plans/${plan.id}/implement`, headers: auth });

    await waitFor(() => getTask(db, task.id)?.status === "done");

    // No 'setting_up' detour at all — the agent saw 'implementing'.
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.taskStatus).toBe("implementing");
    expect(listWorktrees(db)[0]?.setup_status).toBe("skipped");
  });

  it("fails the run without starting the agent when setup fails", async () => {
    const project = createProject(db, {
      name: "demo",
      repoPath,
      setupCommand: "echo 'ERR_PNPM_OUTDATED_LOCKFILE' >&2; exit 9",
    });
    const { task, plan } = approvedPlanFor(project);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/implement`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);
    const runId = res.json().run.id as number;

    await waitFor(() => getTask(db, task.id)?.status === "failed");

    const worktree = listWorktrees(db)[0]!;
    expect(worktree.setup_status).toBe("failed");
    expect(worktree.setup_exit_code).toBe(9);
    expect(worktree.setup_output).toContain("ERR_PNPM_OUTDATED_LOCKFILE");

    const run = getRun(db, runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("setup command exited 9");
    // The whole point: the agent is never handed a half-installed worktree.
    expect(agentCalls).toHaveLength(0);
  });

  it("retries the same plan in a fresh worktree, discarding the one setup failed in", async () => {
    // Fails until the marker file exists: the shape of a real retry, where
    // the operator fixes the environment between the two attempts.
    const fixed = path.join(base, "environment-fixed");
    const project = createProject(db, {
      name: "demo",
      repoPath,
      setupCommand: `test -f ${fixed}`,
    });
    const { task, plan } = approvedPlanFor(project);

    await server.app.inject({ method: "POST", url: `/api/plans/${plan.id}/implement`, headers: auth });
    await waitFor(() => getTask(db, task.id)?.status === "failed");

    const failed = listWorktrees(db)[0]!;
    expect(failed.setup_status).toBe("failed");
    expect(agentCalls).toHaveLength(0);

    writeFileSync(fixed, "");
    const retry = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/implement`,
      headers: auth,
    });
    expect(retry.statusCode).toBe(202);
    await waitFor(() => getTask(db, task.id)?.status === "done");

    // A second attempt, on its own path and branch — not a reuse of the
    // half-installed one.
    const worktrees = listWorktrees(db); // newest first
    expect(worktrees).toHaveLength(2);
    const fresh = worktrees[0]!;
    expect(fresh.id).not.toBe(failed.id);
    expect(fresh.branch).not.toBe(failed.branch);
    expect(fresh.setup_status).toBe("succeeded");

    // …and the failed attempt is gone: directory, branch, and status.
    expect(getWorktree(db, failed.id)?.status).toBe("removed");
    expect(existsSync(failed.worktree_path)).toBe(false);
    expect(git(["branch", "--list", failed.branch], repoPath)).toBe("");

    // The same approved plan reached the agent, in the new worktree.
    expect(agentCalls).toEqual([
      { runId: retry.json().run.id, worktreePath: fresh.worktree_path, taskStatus: "implementing" },
    ]);
  });

  it("exposes the setup state and (empty) todo list on the run endpoint", async () => {
    const project = createProject(db, {
      name: "demo",
      repoPath,
      setupCommand: "exit 1",
    });
    const { task, plan } = approvedPlanFor(project);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/implement`,
      headers: auth,
    });
    const runId = res.json().run.id as number;
    await waitFor(() => getTask(db, task.id)?.status === "failed");

    const detail = (await server.app.inject({ method: "GET", url: `/api/runs/${runId}`, headers: auth })).json();
    expect(detail.worktree.setup_status).toBe("failed");
    expect(detail.todos).toBeNull();
  });
});
