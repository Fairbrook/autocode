import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.ts";
import { createProject, listProjects, upsertProjectSeeds } from "../../src/db/repo/projects.ts";
import { createTask } from "../../src/db/repo/tasks.ts";
import { createRun } from "../../src/db/repo/runs.ts";
import {
  createWorktree,
  getWorktree,
  markWorktreeSetupStarted,
  markWorktreeSetupFinished,
  listWorktreesBySetupStatus,
} from "../../src/db/repo/worktrees.ts";
import { upsertRunTodos, getRunTodos } from "../../src/db/repo/todos.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "autocode-setup-db-test-"));
  db = openDb(path.join(dir, "test.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeWorktree() {
  const project = createProject(db, {
    name: "demo",
    repoPath: "/tmp/demo-repo",
    setupCommand: "pnpm install --frozen-lockfile",
  });
  const task = createTask(db, { projectId: project.id, title: "t", description: "d" });
  const worktree = createWorktree(db, {
    taskId: task.id,
    repoPath: project.repo_path,
    worktreePath: "/tmp/demo-wt",
    branch: "autocode/demo-1",
    baseRef: "HEAD",
    baseSha: "deadbeef",
    scratchPath: "/tmp/demo-scratch",
  });
  return { project, task, worktree };
}

describe("worktree setup persistence", () => {
  it("stores a per-project setup command and seeds it from projects.json", () => {
    const { project } = makeWorktree();
    expect(project.setup_command).toBe("pnpm install --frozen-lockfile");

    upsertProjectSeeds(db, [
      {
        name: "demo",
        repoPath: "/tmp/demo-repo",
        defaultBaseRef: "HEAD",
        ruleProfile: null,
        allowedNetworkDomains: [],
        setupCommand: "uv sync",
        allowDockerSocket: false,
        localServiceHosts: [],
        allowUnsandboxedCommands: false,
      },
    ]);
    expect(listProjects(db)[0]?.setup_command).toBe("uv sync");
  });

  it("keeps docker socket access off unless projects.json asks for it, and revokes it when the seed drops the flag", () => {
    // Root-equivalent grant (see docs/SANDBOX-FINDINGS.md) — the default has
    // to be off, and re-seeding has to be able to take it back, otherwise
    // removing the line from projects.json would silently leave it enabled.
    const project = createProject(db, { name: "demo", repoPath: "/tmp/demo-repo" });
    expect(project.allow_docker_socket).toBe(0);

    const seed = {
      name: "demo",
      repoPath: "/tmp/demo-repo",
      defaultBaseRef: "HEAD",
      ruleProfile: null,
      allowedNetworkDomains: [],
      setupCommand: null,
      allowDockerSocket: true,
      localServiceHosts: [],
      allowUnsandboxedCommands: false,
    };
    upsertProjectSeeds(db, [seed]);
    expect(listProjects(db)[0]?.allow_docker_socket).toBe(1);

    upsertProjectSeeds(db, [{ ...seed, allowDockerSocket: false }]);
    expect(listProjects(db)[0]?.allow_docker_socket).toBe(0);
  });

  it("seeds and revokes the local-service and unsandboxed-command grants the same way", () => {
    // Same reasoning as the docker socket: both drop enforcement (one changes
    // loopback routing, the other takes build/test commands out of the kernel
    // sandbox entirely — see the 006 migration), so deleting the line from
    // projects.json has to take the grant back rather than leave a stale 1.
    const project = createProject(db, { name: "demo", repoPath: "/tmp/demo-repo" });
    expect(project.local_service_hosts).toBe("[]");
    expect(project.allow_unsandboxed_commands).toBe(0);

    const seed = {
      name: "demo",
      repoPath: "/tmp/demo-repo",
      defaultBaseRef: "HEAD",
      ruleProfile: null,
      allowedNetworkDomains: [],
      setupCommand: null,
      allowDockerSocket: false,
      localServiceHosts: ["127.0.0.1"],
      allowUnsandboxedCommands: true,
    };
    upsertProjectSeeds(db, [seed]);
    expect(listProjects(db)[0]?.local_service_hosts).toBe('["127.0.0.1"]');
    expect(listProjects(db)[0]?.allow_unsandboxed_commands).toBe(1);

    upsertProjectSeeds(db, [{ ...seed, localServiceHosts: [], allowUnsandboxedCommands: false }]);
    expect(listProjects(db)[0]?.local_service_hosts).toBe("[]");
    expect(listProjects(db)[0]?.allow_unsandboxed_commands).toBe(0);
  });

  it("defaults to 'skipped' and records the full setup lifecycle", () => {
    const { worktree } = makeWorktree();
    // A worktree for a project with no setup command never enters the
    // lifecycle at all — 'skipped' is what the UI keys off to hide the card.
    expect(worktree.setup_status).toBe("skipped");
    expect(worktree.setup_command).toBeNull();

    markWorktreeSetupStarted(db, worktree.id, "pnpm install --frozen-lockfile");
    const running = getWorktree(db, worktree.id);
    expect(running?.setup_status).toBe("running");
    expect(running?.setup_command).toBe("pnpm install --frozen-lockfile");
    expect(running?.setup_started_at).not.toBeNull();
    expect(listWorktreesBySetupStatus(db, "running").map((w) => w.id)).toEqual([worktree.id]);

    markWorktreeSetupFinished(db, worktree.id, {
      status: "succeeded",
      exitCode: 0,
      output: "Done in 12s",
    });
    const done = getWorktree(db, worktree.id);
    expect(done?.setup_status).toBe("succeeded");
    expect(done?.setup_exit_code).toBe(0);
    expect(done?.setup_output).toBe("Done in 12s");
    expect(done?.setup_ended_at).not.toBeNull();
    expect(listWorktreesBySetupStatus(db, "running")).toHaveLength(0);
  });

  it("clears the previous attempt's result when setup restarts", () => {
    const { worktree } = makeWorktree();
    markWorktreeSetupStarted(db, worktree.id, "pnpm install");
    markWorktreeSetupFinished(db, worktree.id, { status: "failed", exitCode: 1, output: "boom" });
    markWorktreeSetupStarted(db, worktree.id, "pnpm install");

    const row = getWorktree(db, worktree.id);
    expect(row?.setup_status).toBe("running");
    expect(row?.setup_exit_code).toBeNull();
    expect(row?.setup_output).toBeNull();
    expect(row?.setup_ended_at).toBeNull();
  });
});

describe("run todos persistence", () => {
  it("replaces the stored list on every write", () => {
    const { task, worktree } = makeWorktree();
    const run = createRun(db, {
      taskId: task.id,
      phase: "implementation",
      model: "sonnet",
      cwd: worktree.worktree_path,
      worktreeId: worktree.id,
    });

    expect(getRunTodos(db, run.id)).toBeNull();

    upsertRunTodos(db, run.id, [
      { content: "Write the failing test", status: "in_progress", activeForm: "Writing the failing test" },
      { content: "Implement", status: "pending", activeForm: "Implementing" },
    ]);
    expect(getRunTodos(db, run.id)).toHaveLength(2);

    // TodoWrite has replace semantics: the second write is the whole truth,
    // not a delta to merge.
    upsertRunTodos(db, run.id, [
      { content: "Write the failing test", status: "completed", activeForm: "Writing the failing test" },
    ]);
    const todos = getRunTodos(db, run.id);
    expect(todos).toHaveLength(1);
    expect(todos?.[0]?.status).toBe("completed");
  });
});
