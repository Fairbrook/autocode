import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server/index.ts";
import type { Db } from "../../src/db/index.ts";
import { createProject } from "../../src/db/repo/projects.ts";
import { createTask, getTask } from "../../src/db/repo/tasks.ts";
import { createRun } from "../../src/db/repo/runs.ts";
import { createPlan, setPlanStatus } from "../../src/db/repo/plans.ts";
import { listWorktrees, getWorktree } from "../../src/db/repo/worktrees.ts";
import { loginAs } from "../helpers/auth.ts";
import { writeTestConfig } from "../helpers/server.ts";

let base: string;
let repoPath: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let db: Db;
let auth: Record<string, string>;
let mainBranch: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Drives a task through the real implement endpoint, with a stand-in agent that edits the worktree. */
async function implementedWorktree(): Promise<{ id: number; branch: string; taskId: number }> {
  const project = createProject(db, { name: "demo", repoPath, setupCommand: null });
  const task = createTask(db, { projectId: project.id, title: "add subtract", description: "…" });
  const planningRun = createRun(db, {
    taskId: task.id,
    phase: "planning",
    model: "opus",
    cwd: repoPath,
  });
  const plan = createPlan(db, {
    taskId: task.id,
    runId: planningRun.id,
    summary: "Add subtract()",
    taskCategory: "feature",
    tddApplies: false,
    tddRationale: "n/a",
    steps: [{ order: 1, description: "add it" }],
    proposedCommands: [],
    proposedDomains: [],
    risks: [],
    files: [],
    rawOutput: {},
  });
  setPlanStatus(db, plan.id, "approved");

  await server.app.inject({ method: "POST", url: `/api/plans/${plan.id}/implement`, headers: auth });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && getTask(db, task.id)?.status !== "done") {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(getTask(db, task.id)?.status).toBe("done");

  const wt = listWorktrees(db)[0]!;
  return { id: wt.id, branch: wt.branch, taskId: task.id };
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-review-api-test-"));
  repoPath = path.join(base, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(["init", "-q", "."], repoPath);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "."], repoPath);
  git(["commit", "-q", "-m", "initial"], repoPath);
  mainBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);

  const { configPath, projectsPath } = writeTestConfig(base);
  server = await buildServer({
    configPath,
    projectsPath,
    // Stands in for the implementation agent: commits one file and leaves
    // another uncommitted, which is what a real run typically looks like.
    runAgent: async (input) => {
      const wtPath = input.worktree.worktree_path;
      writeFileSync(path.join(wtPath, "subtract.ts"), "export const subtract = (a, b) => a - b;\n");
      git(["add", "-A"], wtPath);
      git(["commit", "-q", "-m", "add subtract"], wtPath);
      writeFileSync(path.join(wtPath, "notes.md"), "still uncommitted\n");
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

describe("GET /api/worktrees/:id/changes", () => {
  it("returns a per-file diff plus the state of a merge into the main checkout", async () => {
    const wt = await implementedWorktree();

    const res = await server.app.inject({
      method: "GET",
      url: `/api/worktrees/${wt.id}/changes`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.files.map((f: { path: string }) => f.path)).toEqual(["notes.md", "subtract.ts"]);
    expect(body.files[1].status).toBe("added");
    expect(body.files[1].patch).toContain("+export const subtract");
    expect(body.files[0].status).toBe("untracked");
    expect(body.stat.filesChanged).toBe(2);

    expect(body.merge.targetBranch).toBe(mainBranch);
    expect(body.merge.repoClean).toBe(true);
    expect(body.merge.worktreeDirty).toBe(true);
    expect(body.merge.alreadyMerged).toBe(false);
    expect(body.merge.commits.map((c: { subject: string }) => c.subject)).toEqual(["add subtract"]);
  });

  it("404s for an unknown worktree", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/worktrees/999/changes",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/worktrees/:id/merge", () => {
  it("merges the branch into the main checkout and records it on the worktree", async () => {
    const wt = await implementedWorktree();

    const res = await server.app.inject({
      method: "POST",
      url: `/api/worktrees/${wt.id}/merge`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.targetBranch).toBe(mainBranch);
    expect(body.alreadyUpToDate).toBe(false);

    // Both the committed and the uncommitted half landed in the user's repo.
    expect(readFileSync(path.join(repoPath, "subtract.ts"), "utf8")).toContain("subtract");
    expect(readFileSync(path.join(repoPath, "notes.md"), "utf8")).toBe("still uncommitted\n");
    expect(git(["status", "--porcelain"], repoPath)).toBe("");
    // The default message is the task's title.
    expect(git(["log", "-1", "--format=%s"], repoPath)).toContain("add subtract");

    const row = getWorktree(db, wt.id)!;
    expect(row.status).toBe("retained");
    expect(row.merge_target_branch).toBe(mainBranch);
    expect(row.merge_commit).toBe(body.headSha);
    expect(row.merged_at).not.toBeNull();
    expect(existsSync(row.worktree_path)).toBe(true);

    // And the state the review pane reads back says so.
    const after = (
      await server.app.inject({
        method: "GET",
        url: `/api/worktrees/${wt.id}/changes`,
        headers: auth,
      })
    ).json();
    expect(after.merge.alreadyMerged).toBe(true);
  });

  it("removes the worktree afterwards when asked", async () => {
    const wt = await implementedWorktree();
    const worktreePath = getWorktree(db, wt.id)!.worktree_path;

    const res = await server.app.inject({
      method: "POST",
      url: `/api/worktrees/${wt.id}/merge`,
      headers: auth,
      payload: { removeWorktree: true, message: "land it" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(true);

    expect(existsSync(worktreePath)).toBe(false);
    expect(getWorktree(db, wt.id)?.status).toBe("removed");
    expect(readFileSync(path.join(repoPath, "subtract.ts"), "utf8")).toContain("subtract");
    expect(git(["log", "-1", "--format=%s"], repoPath)).toBe("land it");
    // The branch goes with it, so retrying this task doesn't collide.
    expect(git(["branch", "--list", wt.branch], repoPath)).toBe("");
  });

  it("refuses with 409 when the main checkout has uncommitted changes", async () => {
    const wt = await implementedWorktree();
    writeFileSync(path.join(repoPath, "README.md"), "my own edit\n");

    const res = await server.app.inject({
      method: "POST",
      url: `/api/worktrees/${wt.id}/merge`,
      headers: auth,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("repo_dirty");
    expect(existsSync(path.join(repoPath, "subtract.ts"))).toBe(false);
    expect(readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe("my own edit\n");
    expect(getWorktree(db, wt.id)?.merged_at).toBeNull();
  });

  it("reports conflicts as 409 and leaves the main checkout untouched", async () => {
    const wt = await implementedWorktree();
    // The user writes the same file on the target branch first.
    writeFileSync(path.join(repoPath, "subtract.ts"), "export const subtract = () => 0;\n");
    git(["add", "-A"], repoPath);
    git(["commit", "-q", "-m", "conflicting work"], repoPath);
    const headBefore = git(["rev-parse", "HEAD"], repoPath);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/worktrees/${wt.id}/merge`,
      headers: auth,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("conflict");
    expect(res.json().conflicts).toEqual(["subtract.ts"]);
    expect(git(["rev-parse", "HEAD"], repoPath)).toBe(headBefore);
    expect(git(["status", "--porcelain"], repoPath)).toBe("");
    expect(readFileSync(path.join(repoPath, "subtract.ts"), "utf8")).toBe(
      "export const subtract = () => 0;\n"
    );
  });
});
