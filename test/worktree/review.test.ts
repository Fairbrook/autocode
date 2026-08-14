import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorktreeOnDisk, type CreatedWorktree } from "../../src/worktree/manager.ts";
import {
  collectWorktreeChanges,
  getMergeState,
  mergeWorktree,
  MergeBlockedError,
  type FileChange,
} from "../../src/worktree/review.ts";

let base: string;
let repoPath: string;
let worktreeRoot: string;
let wt: CreatedWorktree;
let mainBranch: string;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", message], cwd);
}

function fileNamed(files: FileChange[], p: string): FileChange {
  const found = files.find((f) => f.path === p);
  if (!found) throw new Error(`no change for ${p} in ${files.map((f) => f.path).join(", ")}`);
  return found;
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-review-test-"));
  repoPath = path.join(base, "repo");
  worktreeRoot = path.join(base, "worktrees");
  git(["init", "-q", repoPath], base);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "hello\nworld\n");
  writeFileSync(path.join(repoPath, "old-name.txt"), "move me\n");
  writeFileSync(path.join(repoPath, "doomed.txt"), "delete me\n");
  commit(repoPath, "initial");
  mainBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);

  wt = createWorktreeOnDisk({
    repoPath,
    taskId: 1,
    taskTitle: "review me",
    baseRef: "HEAD",
    worktreeRoot,
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("collectWorktreeChanges", () => {
  it("returns one patch per file for the whole branch, not per commit", () => {
    // Two commits touching the same file: the review pane should show their
    // net effect as a single diff, which is what a merge would actually land.
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nthere\n");
    commit(wt.worktreePath, "first pass");
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nthere again\n");
    commit(wt.worktreePath, "second pass");

    const { files, stat } = collectWorktreeChanges(wt.worktreePath, wt.baseSha);

    expect(files).toHaveLength(1);
    const readme = files[0]!;
    expect(readme.path).toBe("README.md");
    expect(readme.status).toBe("modified");
    expect(readme.patch).toContain("+there again");
    expect(readme.patch).toContain("-world");
    // "there" from the intermediate commit never existed at either end.
    expect(readme.patch).not.toContain("+there\n");
    expect(readme.insertions).toBe(1);
    expect(readme.deletions).toBe(1);
    expect(stat).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 });
  });

  it("covers added, deleted, renamed, uncommitted and untracked files", () => {
    writeFileSync(path.join(wt.worktreePath, "added.ts"), "export const a = 1;\n");
    unlinkSync(path.join(wt.worktreePath, "doomed.txt"));
    git(["mv", "old-name.txt", "new-name.txt"], wt.worktreePath);
    commit(wt.worktreePath, "the agent's work");

    // Left behind uncommitted — the common shape of a finished run.
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nworld\nuncommitted\n");
    writeFileSync(path.join(wt.worktreePath, "scratch.txt"), "never added to the index\n");

    const { files } = collectWorktreeChanges(wt.worktreePath, wt.baseSha);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.status]));

    expect(byPath).toEqual({
      "README.md": "modified",
      "added.ts": "added",
      "doomed.txt": "deleted",
      "new-name.txt": "renamed",
      "scratch.txt": "untracked",
    });
    expect(fileNamed(files, "new-name.txt").oldPath).toBe("old-name.txt");
    expect(fileNamed(files, "README.md").patch).toContain("+uncommitted");
    expect(fileNamed(files, "scratch.txt").patch).toContain("+never added to the index");
    expect(fileNamed(files, "doomed.txt").patch).toContain("-delete me");
  });

  it("flags binary files instead of trying to diff them", () => {
    writeFileSync(path.join(wt.worktreePath, "logo.png"), Buffer.from([0, 1, 2, 0, 3, 255]));
    commit(wt.worktreePath, "add a binary");

    const png = fileNamed(collectWorktreeChanges(wt.worktreePath, wt.baseSha).files, "logo.png");
    expect(png.binary).toBe(true);
    expect(png.insertions).toBe(0);
    expect(png.deletions).toBe(0);
  });

  it("handles paths with spaces and quotes", () => {
    const weird = 'a dir/we"ird name.txt';
    execFileSync("mkdir", ["-p", path.join(wt.worktreePath, "a dir")]);
    writeFileSync(path.join(wt.worktreePath, weird), "hi\n");
    commit(wt.worktreePath, "odd path");

    const { files } = collectWorktreeChanges(wt.worktreePath, wt.baseSha);
    expect(files.map((f) => f.path)).toEqual([weird]);
  });
});

describe("getMergeState", () => {
  it("reports the target branch, cleanliness and the branch's commits", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nchanged\n");
    commit(wt.worktreePath, "change the readme");
    writeFileSync(path.join(wt.worktreePath, "leftover.txt"), "uncommitted\n");

    const state = getMergeState({
      repoPath,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseSha: wt.baseSha,
    });

    expect(state.targetBranch).toBe(mainBranch);
    expect(state.repoClean).toBe(true);
    expect(state.worktreeDirty).toBe(true);
    expect(state.worktreeDirtyFiles).toHaveLength(1);
    expect(state.commits.map((c) => c.subject)).toEqual(["change the readme"]);
    expect(state.alreadyMerged).toBe(false);
    expect(state.targetAdvancedBy).toBe(0);
  });

  it("notices a dirty main checkout and a target branch that has moved on", () => {
    writeFileSync(path.join(repoPath, "other.txt"), "someone else's work\n");
    commit(repoPath, "unrelated work on the target");
    writeFileSync(path.join(repoPath, "dirty.txt"), "not committed\n");

    const state = getMergeState({
      repoPath,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseSha: wt.baseSha,
    });

    expect(state.repoClean).toBe(false);
    expect(state.repoDirtyFiles.join()).toContain("dirty.txt");
    expect(state.targetAdvancedBy).toBe(1);
  });
});

describe("mergeWorktree", () => {
  it("lands the branch on the main checkout, committing whatever was left uncommitted", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\ncommitted\n");
    commit(wt.worktreePath, "committed work");
    writeFileSync(path.join(wt.worktreePath, "late.txt"), "left uncommitted by the agent\n");

    const result = mergeWorktree({
      repoPath,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      message: "review me",
    });

    expect(result.targetBranch).toBe(mainBranch);
    expect(result.alreadyUpToDate).toBe(false);
    expect(result.autoCommit).not.toBeNull();

    // Both halves are in the user's own checkout now.
    expect(readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe("hello\ncommitted\n");
    expect(readFileSync(path.join(repoPath, "late.txt"), "utf8")).toBe(
      "left uncommitted by the agent\n"
    );
    expect(git(["status", "--porcelain"], repoPath)).toBe("");
    // --no-ff, so the merge is visible in the history rather than fast-forwarded away.
    expect(git(["rev-list", "--count", "--merges", "HEAD"], repoPath)).toBe("1");
    expect(git(["log", "-1", "--format=%s"], repoPath)).toContain("review me");
    expect(git(["rev-parse", "HEAD"], repoPath)).toBe(result.headSha);
  });

  it("squashes the branch into a single non-merge commit when asked", () => {
    writeFileSync(path.join(wt.worktreePath, "one.txt"), "1\n");
    commit(wt.worktreePath, "step one");
    writeFileSync(path.join(wt.worktreePath, "two.txt"), "2\n");
    commit(wt.worktreePath, "step two");

    const result = mergeWorktree({
      repoPath,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      mode: "squash",
      message: "one commit please",
    });

    expect(result.mode).toBe("squash");
    expect(git(["rev-list", "--count", "--merges", "HEAD"], repoPath)).toBe("0");
    expect(git(["log", "-1", "--format=%s"], repoPath)).toBe("one commit please");
    expect(git(["rev-list", "--count", `${wt.baseSha}..HEAD`], repoPath)).toBe("1");
    expect(readFileSync(path.join(repoPath, "two.txt"), "utf8")).toBe("2\n");
  });

  it("refuses to merge into a dirty checkout instead of burying the user's own work", () => {
    writeFileSync(path.join(wt.worktreePath, "one.txt"), "1\n");
    commit(wt.worktreePath, "agent work");
    writeFileSync(path.join(repoPath, "README.md"), "my own uncommitted edit\n");

    const err = (() => {
      try {
        mergeWorktree({ repoPath, worktreePath: wt.worktreePath, branch: wt.branch, message: "x" });
        return null;
      } catch (e) {
        return e as MergeBlockedError;
      }
    })();

    expect(err).toBeInstanceOf(MergeBlockedError);
    expect(err!.code).toBe("repo_dirty");
    expect(err!.details.files?.join()).toContain("README.md");
    // The user's edit is untouched and nothing was merged.
    expect(readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe("my own uncommitted edit\n");
    expect(git(["rev-list", "--count", `${wt.baseSha}..HEAD`], repoPath)).toBe("0");
  });

  it("rolls the merge back and names the conflicting files", () => {
    writeFileSync(path.join(repoPath, "README.md"), "hello\nfrom the main branch\n");
    commit(repoPath, "main moves on");
    const headBefore = git(["rev-parse", "HEAD"], repoPath);

    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nfrom the worktree\n");
    commit(wt.worktreePath, "agent moves the same line");

    const err = (() => {
      try {
        mergeWorktree({ repoPath, worktreePath: wt.worktreePath, branch: wt.branch, message: "x" });
        return null;
      } catch (e) {
        return e as MergeBlockedError;
      }
    })();

    expect(err).toBeInstanceOf(MergeBlockedError);
    expect(err!.code).toBe("conflict");
    expect(err!.details.conflicts).toEqual(["README.md"]);
    // The main checkout is exactly where it was — no conflict markers, no
    // half-finished merge for the user to find later in a shell.
    expect(git(["rev-parse", "HEAD"], repoPath)).toBe(headBefore);
    expect(git(["status", "--porcelain"], repoPath)).toBe("");
    expect(readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe(
      "hello\nfrom the main branch\n"
    );
  });

  it("is a no-op the second time", () => {
    writeFileSync(path.join(wt.worktreePath, "one.txt"), "1\n");
    commit(wt.worktreePath, "agent work");
    mergeWorktree({ repoPath, worktreePath: wt.worktreePath, branch: wt.branch, message: "first" });

    const again = mergeWorktree({
      repoPath,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      message: "second",
    });

    expect(again.alreadyUpToDate).toBe(true);
    expect(git(["rev-list", "--count", "--merges", "HEAD"], repoPath)).toBe("1");
  });
});
