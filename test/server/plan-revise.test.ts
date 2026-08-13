import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server/index.ts";
import type { Db } from "../../src/db/index.ts";
import { createProject } from "../../src/db/repo/projects.ts";
import { createTask, getTask } from "../../src/db/repo/tasks.ts";
import { createRun } from "../../src/db/repo/runs.ts";
import { createPlan, getPlan, listPlanVersions } from "../../src/db/repo/plans.ts";
import { writeTestConfig } from "../helpers/server.ts";
import { loginAs } from "../helpers/auth.ts";

let base: string;
let repoPath: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let db: Db;
let auth: Record<string, string>;
/** The plan the agent was actually handed, captured from the stand-in implementer. */
let agentPlans: { summary: string; steps: string[] }[];

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function seedPlan() {
  const project = createProject(db, { name: "demo", repoPath, setupCommand: null });
  const task = createTask(db, {
    projectId: project.id,
    title: "add a rate limiter",
    description: "cap requests per IP",
  });
  const run = createRun(db, {
    taskId: task.id,
    phase: "planning",
    model: "opus",
    cwd: project.repo_path,
  });
  const plan = createPlan(db, {
    taskId: task.id,
    runId: run.id,
    summary: "Add a rate limiter",
    taskCategory: "feature",
    tddApplies: true,
    tddRationale: "new behavior",
    steps: [
      { order: 1, description: "Write the failing test" },
      { order: 2, description: "Implement the limiter" },
    ],
    proposedCommands: [{ pattern: "pnpm vitest run", why: "tests", category: "test" }],
    proposedDomains: [],
    risks: ["might slow the hot path"],
    files: ["src/api/limiter.ts"],
    rawOutput: { summary: "Add a rate limiter" },
  });
  return { project, task, plan };
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-plan-test-"));
  repoPath = path.join(base, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(["init", "-q", "."], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "."], repoPath);
  git(["commit", "-q", "-m", "initial"], repoPath);

  const { configPath, projectsPath } = writeTestConfig(base);
  agentPlans = [];
  server = await buildServer({
    configPath,
    projectsPath,
    runAgent: async (input) => {
      agentPlans.push({
        summary: input.plan.summary,
        steps: (JSON.parse(input.plan.steps_json) as { description: string }[]).map(
          (s) => s.description
        ),
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

describe("POST /api/plans/:id/revise", () => {
  it("writes a new version and supersedes the old one", async () => {
    const { task, plan } = seedPlan();

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: {
        steps: ["Write the failing test", "Reuse the existing retry helper", "Wire it in"],
        note: "use the helper we already have",
      },
    });
    expect(res.statusCode).toBe(201);

    const revision = res.json().plan;
    expect(revision.version).toBe(2);
    expect(revision.source).toBe("user_edit");
    expect(revision.status).toBe("pending");
    expect(revision.supersedes_plan_id).toBe(plan.id);
    expect(revision.edit_note).toBe("use the helper we already have");

    // The original is kept, marked superseded — what the model proposed is
    // still recoverable next to what the human changed.
    expect(getPlan(db, plan.id)?.status).toBe("superseded");
    expect(listPlanVersions(db, task.id)).toHaveLength(2);

    // And the task view now shows the revision.
    const taskView = await server.app.inject({
      method: "GET",
      url: `/api/tasks/${task.id}`,
      headers: auth,
    });
    expect(taskView.json().plan.id).toBe(revision.id);
  });

  it("keeps the planner's raw output on the revision", async () => {
    const { plan } = seedPlan();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { summary: "Completely different summary" },
    });
    // The record of what the model actually said must survive the edit.
    expect(JSON.parse(res.json().plan.raw_output_json).summary).toBe("Add a rate limiter");
  });

  it("does not mint a version when nothing changed", async () => {
    const { task, plan } = seedPlan();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { summary: "Add a rate limiter" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(false);
    expect(listPlanVersions(db, task.id)).toHaveLength(1);
  });

  it("rejects an edit that empties the plan", async () => {
    const { plan } = seedPlan();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { steps: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one step/i);
  });

  it("can be edited repeatedly, stacking versions", async () => {
    const { task, plan } = seedPlan();
    let current = plan.id;
    for (const summary of ["second thoughts", "third thoughts", "final answer"]) {
      const res = await server.app.inject({
        method: "POST",
        url: `/api/plans/${current}/revise`,
        headers: auth,
        payload: { summary },
      });
      expect(res.statusCode).toBe(201);
      current = res.json().plan.id;
    }
    const versions = listPlanVersions(db, task.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    // Exactly one live version at any time.
    expect(versions.filter((v) => v.status !== "superseded")).toHaveLength(1);
  });

  it("refuses to edit a superseded version", async () => {
    const { plan } = seedPlan();
    await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { summary: "v2" },
    });
    const stale = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { summary: "editing the old one" },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("refuses once implementation has started", async () => {
    const { task, plan } = seedPlan();
    createRun(db, {
      taskId: task.id,
      phase: "implementation",
      model: "sonnet",
      cwd: repoPath,
    });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { summary: "too late" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already started/i);
  });

  it("sends an approved plan back for review when it's edited afterwards", async () => {
    const { task, plan } = seedPlan();
    await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/approve`,
      headers: auth,
      payload: { commands: [], domains: [] },
    });
    expect(getTask(db, task.id)?.status).toBe("approved");

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/revise`,
      headers: auth,
      payload: { summary: "actually, one more thing" },
    });
    expect(res.statusCode).toBe(201);
    // What was approved is no longer what would run, so it needs a fresh look.
    expect(getTask(db, task.id)?.status).toBe("awaiting_approval");
    expect(res.json().plan.status).toBe("pending");
  });
});

describe("approve with inline edits", () => {
  it("saves the edit and approves the new version in one call", async () => {
    const { task, plan } = seedPlan();

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/approve`,
      headers: auth,
      payload: {
        commands: [{ pattern: "pnpm vitest run", origin: "proposed" }],
        domains: [],
        plan: { steps: ["Reuse the existing retry helper", "Add the test"] },
      },
    });
    expect(res.statusCode).toBe(200);

    const approvedId = res.json().planId;
    expect(approvedId).not.toBe(plan.id);

    const approved = getPlan(db, approvedId)!;
    expect(approved.status).toBe("approved");
    expect(approved.version).toBe(2);
    expect(getPlan(db, plan.id)?.status).toBe("superseded");
    expect(getTask(db, task.id)?.status).toBe("approved");
  });

  it("approves in place when the plan wasn't touched", async () => {
    const { plan } = seedPlan();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/approve`,
      headers: auth,
      payload: { commands: [], domains: [], plan: { summary: "Add a rate limiter" } },
    });
    expect(res.json().planId).toBe(plan.id);
    expect(getPlan(db, plan.id)?.status).toBe("approved");
  });

  it("hands the edited plan — not the original — to the implementation agent", async () => {
    const { plan } = seedPlan();

    const approve = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/approve`,
      headers: auth,
      payload: {
        commands: [],
        domains: [],
        plan: {
          summary: "Add a token-bucket rate limiter",
          steps: ["Reuse the existing retry helper", "Add the test"],
        },
      },
    });
    const approvedId = approve.json().planId;

    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${approvedId}/implement`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);

    const deadline = Date.now() + 10_000;
    while (agentPlans.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(agentPlans).toHaveLength(1);
    expect(agentPlans[0]?.summary).toBe("Add a token-bucket rate limiter");
    expect(agentPlans[0]?.steps).toEqual(["Reuse the existing retry helper", "Add the test"]);
  });

  it("refuses to approve an edit that empties the plan", async () => {
    const { plan } = seedPlan();
    const res = await server.app.inject({
      method: "POST",
      url: `/api/plans/${plan.id}/approve`,
      headers: auth,
      payload: { commands: [], domains: [], plan: { steps: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(getPlan(db, plan.id)?.status).toBe("pending");
  });
});
