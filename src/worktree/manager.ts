import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

/** Runs git with explicit argv (never a shell string) — no injection surface regardless of what's in taskTitle/branch names. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "task";
}

export interface CreatedWorktree {
  branch: string;
  worktreePath: string;
  scratchPath: string;
  baseSha: string;
}

export function createWorktreeOnDisk(input: {
  repoPath: string;
  taskId: number;
  taskTitle: string;
  baseRef: string;
  worktreeRoot: string;
  /**
   * Distinguishes retries of the same task. Both `worktree_path` and the
   * branch name are otherwise fully deterministic from taskId alone, which
   * means a discarded-then-retried task collides on both — the DB's
   * `worktree_path` UNIQUE constraint and git's "branch already exists"
   * both fire. Defaults to 1 for a task's first attempt; the caller should
   * pass `(number of prior worktree rows for this task) + 1`.
   */
  attempt?: number;
}): CreatedWorktree {
  const repoAbs = path.resolve(input.repoPath);
  if (!existsSync(path.join(repoAbs, ".git")) && !isGitRepo(repoAbs)) {
    throw new Error(`${repoAbs} does not look like a git repository (no .git found)`);
  }

  const attempt = input.attempt ?? 1;
  const suffix = attempt > 1 ? `-${attempt}` : "";
  const baseSha = git(["rev-parse", input.baseRef], repoAbs);
  const slug = slugify(input.taskTitle);
  const branch = `autocode/${slug}-${input.taskId}${suffix}`;
  const repoName = path.basename(repoAbs);
  const worktreePath = path.join(
    input.worktreeRoot,
    repoName,
    `task-${input.taskId}${suffix}`
  );
  const scratchPath = path.join(
    input.worktreeRoot,
    repoName,
    `task-${input.taskId}${suffix}-scratch`
  );

  mkdirSync(path.dirname(worktreePath), { recursive: true });
  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }

  git(["worktree", "add", "-b", branch, worktreePath, baseSha], repoAbs);
  mkdirSync(scratchPath, { recursive: true });

  return { branch, worktreePath, scratchPath, baseSha };
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], {
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  summary: string;
}

export function getDiffStat(worktreePath: string, baseSha: string): DiffStat {
  const summary = git(["diff", "--stat", baseSha, "--"], worktreePath);
  const shortstat = git(["diff", "--shortstat", baseSha, "--"], worktreePath);
  const filesChanged = Number(/(\d+) files? changed/.exec(shortstat)?.[1] ?? 0);
  const insertions = Number(/(\d+) insertions?\(\+\)/.exec(shortstat)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletions?\(-\)/.exec(shortstat)?.[1] ?? 0);
  return { filesChanged, insertions, deletions, summary };
}

export function currentBranchIsClean(worktreePath: string): boolean {
  const status = git(["status", "--porcelain"], worktreePath);
  return status === "";
}

/**
 * Removes the worktree and its scratch dir from disk. By default the
 * branch itself is left alone — the commits stay reachable so the user can
 * still look at what the agent did. Pass `deleteBranch: true` for a true
 * discard (e.g. retrying a task after an interrupted run): worktree branch
 * names are deterministic per task
 * (`autocode/<slug>-<taskId>`, see createWorktreeOnDisk), so a stale branch
 * left behind by a discarded worktree blocks every future retry of that
 * same task with "a branch named ... already exists" — confirmed live
 * during the Gate 4 dry run.
 */
export function removeWorktreeFromDisk(input: {
  repoPath: string;
  worktreePath: string;
  scratchPath: string;
  branch?: string;
  deleteBranch?: boolean;
  force?: boolean;
}): void {
  const repoAbs = path.resolve(input.repoPath);
  const args = ["worktree", "remove", input.worktreePath];
  if (input.force) args.push("--force");
  git(args, repoAbs);
  rmSync(input.scratchPath, { recursive: true, force: true });
  if (input.deleteBranch && input.branch) {
    git(["branch", "-D", input.branch], repoAbs);
  }
}
