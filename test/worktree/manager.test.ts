import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorktreeOnDisk,
  getDiffStat,
  currentBranchIsClean,
  removeWorktreeFromDisk,
} from "../../src/worktree/manager.ts";

let base: string;
let repoPath: string;
let worktreeRoot: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-wt-test-"));
  repoPath = path.join(base, "repo");
  worktreeRoot = path.join(base, "worktrees");
  git(["init", "-q", repoPath], base);
  git(["-C", repoPath, "config", "user.email", "test@example.com"], base);
  git(["-C", repoPath, "config", "user.name", "Test"], base);
  writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["-C", repoPath, "add", "."], base);
  git(["-C", repoPath, "commit", "-q", "-m", "initial"], base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("worktree manager", () => {
  it("creates a worktree on its own branch without touching the main checkout", () => {
    const wt = createWorktreeOnDisk({
      repoPath,
      taskId: 1,
      taskTitle: "Add subtract function",
      baseRef: "HEAD",
      worktreeRoot,
    });

    expect(wt.branch).toBe("autocode/add-subtract-function-1");
    expect(currentBranchIsClean(wt.worktreePath)).toBe(true);

    // Main checkout's branch must be unaffected.
    const mainBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    expect(mainBranch).not.toBe(wt.branch);

    // Write inside the worktree and commit — must not touch the main checkout's working tree.
    writeFileSync(path.join(wt.worktreePath, "subtract.ts"), "export const subtract = (a, b) => a - b;\n");
    git(["-C", wt.worktreePath, "add", "."], wt.worktreePath);
    git(["-C", wt.worktreePath, "commit", "-q", "-m", "add subtract"], wt.worktreePath);

    const mainStatus = git(["status", "--porcelain"], repoPath);
    expect(mainStatus).toBe("");

    const stat = getDiffStat(wt.worktreePath, wt.baseSha);
    expect(stat.filesChanged).toBe(1);
    expect(stat.insertions).toBeGreaterThan(0);

    removeWorktreeFromDisk({
      repoPath,
      worktreePath: wt.worktreePath,
      scratchPath: wt.scratchPath,
    });

    // The commit itself must still exist on the branch even after the worktree is removed.
    const log = git(["log", "--oneline", wt.branch], repoPath);
    expect(log).toContain("add subtract");
  });

  it("refuses to create a worktree at a path that already exists", () => {
    const wt = createWorktreeOnDisk({
      repoPath,
      taskId: 2,
      taskTitle: "dup",
      baseRef: "HEAD",
      worktreeRoot,
    });
    expect(() =>
      createWorktreeOnDisk({
        repoPath,
        taskId: 2,
        taskTitle: "dup",
        baseRef: "HEAD",
        worktreeRoot,
      })
    ).toThrow();
    removeWorktreeFromDisk({
      repoPath,
      worktreePath: wt.worktreePath,
      scratchPath: wt.scratchPath,
    });
  });

  it("deleting the branch on discard allows retrying the same task afterward", () => {
    const wt = createWorktreeOnDisk({
      repoPath,
      taskId: 4,
      taskTitle: "retry me",
      baseRef: "HEAD",
      worktreeRoot,
    });
    removeWorktreeFromDisk({
      repoPath,
      worktreePath: wt.worktreePath,
      scratchPath: wt.scratchPath,
      branch: wt.branch,
      deleteBranch: true,
    });
    // Without deleteBranch, retrying the same task would fail with
    // "a branch named ... already exists" — confirmed live during Gate 4.
    expect(() =>
      createWorktreeOnDisk({
        repoPath,
        taskId: 4,
        taskTitle: "retry me",
        baseRef: "HEAD",
        worktreeRoot,
      })
    ).not.toThrow();
  });

  it("rejects a repoPath that isn't a git repository", () => {
    const notARepo = path.join(base, "plain-dir");
    execFileSync("mkdir", ["-p", notARepo]);
    expect(() =>
      createWorktreeOnDisk({
        repoPath: notARepo,
        taskId: 3,
        taskTitle: "x",
        baseRef: "HEAD",
        worktreeRoot,
      })
    ).toThrow();
  });
});
