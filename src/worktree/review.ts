import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Reviewing a worktree and landing it in the main checkout. Everything here
 * shells out to git with an explicit argv (never a shell string), same as
 * manager.ts — branch names and paths come from the database and from the
 * agent's own file writes, so neither is trusted as shell input.
 */

/** A single file's patch is capped so one generated lockfile can't push a 40 MB payload at the browser. */
const MAX_PATCH_BYTES = 200_000;
/** Diffs are routinely bigger than execFileSync's 1 MB default. */
const MAX_BUFFER = 128 * 1024 * 1024;
/** The branch's own commits are listed for context, not paginated. */
const MAX_COMMITS = 50;

export function git(args: string[], cwd: string): string {
  return raw(args, cwd).trim();
}

function raw(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
}

/**
 * `git diff` exits 1 when there *are* differences under `--no-index` (and
 * under `--exit-code`), which execFileSync reports as a thrown error even
 * though the patch we want is sitting in stdout.
 */
function rawAllowingDiffExit(args: string[], cwd: string): string {
  try {
    return raw(args, cwd);
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && typeof e.stdout === "string") return e.stdout;
    throw err;
  }
}

/** Runs a git predicate command (`merge-base --is-ancestor`, …) and returns its exit code. */
export function exitCode(args: string[], cwd: string): number {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s !== "");
}

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  /** On disk but never added to the index — the agent's new files before it commits. */
  | "untracked";

export interface FileChange {
  path: string;
  /** Only set for renames/copies. */
  oldPath: string | null;
  status: FileChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff, exactly as git prints it. */
  patch: string;
  /** True when `patch` was cut at MAX_PATCH_BYTES. */
  truncated: boolean;
}

export interface WorktreeChanges {
  files: FileChange[];
  stat: { filesChanged: number; insertions: number; deletions: number };
}

/**
 * Every file that differs between the worktree's base commit and what is on
 * disk right now — one patch per file, with the branch's commits collapsed
 * together. Deliberately *not* per commit: what matters at review time is
 * the net change the merge would introduce, and the agent's commit
 * boundaries are an implementation detail of how it got there.
 *
 * Uncommitted work counts (`git diff <base>` compares against the working
 * tree) and so do untracked files, which is the common case for a run that
 * ended without the agent committing.
 */
export function collectWorktreeChanges(worktreePath: string, baseSha: string): WorktreeChanges {
  if (!existsSync(worktreePath)) {
    throw new Error(`worktree is no longer on disk: ${worktreePath}`);
  }

  const files: FileChange[] = [];

  for (const entry of parseNameStatus(
    raw(["diff", "-M", "-z", "--name-status", baseSha, "--"], worktreePath)
  )) {
    // Both sides of a rename are passed as the pathspec so rename detection
    // survives being narrowed to one file.
    const pathspec = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
    const patch = raw(
      ["diff", "-M", "--no-color", baseSha, "--", ...pathspec],
      worktreePath
    );
    files.push(toFileChange(entry.status, entry.path, entry.oldPath, patch));
  }

  for (const untracked of splitZ(
    raw(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath)
  )) {
    // `--no-index` is what makes a file git has never seen diffable at all.
    const patch = rawAllowingDiffExit(
      ["diff", "--no-color", "--no-index", "--", "/dev/null", untracked],
      worktreePath
    );
    files.push(toFileChange("untracked", untracked, null, patch));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    files,
    stat: {
      filesChanged: files.length,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
  };
}

interface NameStatusEntry {
  status: FileChangeStatus;
  path: string;
  oldPath: string | null;
}

/**
 * `--name-status -z` emits `<status>\0<path>\0`, except renames and copies
 * which emit `<status>\0<oldPath>\0<newPath>\0`. NUL framing (rather than
 * lines) is what makes paths with spaces, quotes or newlines in them safe to
 * parse.
 */
function parseNameStatus(out: string): NameStatusEntry[] {
  const tokens = splitZ(out);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++] ?? "";
    const letter = code[0] ?? "";
    if ((letter === "R" || letter === "C") && i + 1 < tokens.length) {
      const oldPath = tokens[i++]!;
      const newPath = tokens[i++]!;
      entries.push({ status: letter === "R" ? "renamed" : "copied", path: newPath, oldPath });
      continue;
    }
    const filePath = tokens[i++];
    if (filePath === undefined) break;
    entries.push({ status: statusFromLetter(letter), path: filePath, oldPath: null });
  }
  return entries;
}

function statusFromLetter(letter: string): FileChangeStatus {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "T") return "type_changed";
  return "modified"; // M, U (unmerged) and anything git adds later
}

function toFileChange(
  status: FileChangeStatus,
  filePath: string,
  oldPath: string | null,
  patch: string
): FileChange {
  const binary = /^Binary files .* differ$/m.test(patch) || patch.includes("GIT binary patch");
  let insertions = 0;
  let deletions = 0;
  if (!binary) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  const truncated = Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES;
  return {
    path: filePath,
    oldPath,
    status,
    insertions,
    deletions,
    binary,
    patch: truncated ? truncatePatch(patch) : patch,
    truncated,
  };
}

/** Cuts at the last whole line inside the budget so the client never has to render half a diff line. */
function truncatePatch(patch: string): string {
  const slice = Buffer.from(patch, "utf8").subarray(0, MAX_PATCH_BYTES).toString("utf8");
  const cut = slice.lastIndexOf("\n");
  return cut > 0 ? slice.slice(0, cut) : slice;
}

export interface MergeState {
  /** Branch checked out in the main repo — the merge target. Null when it's on a detached HEAD. */
  targetBranch: string | null;
  repoClean: boolean;
  /** `git status --porcelain` lines from the main checkout, when it isn't clean. */
  repoDirtyFiles: string[];
  worktreeDirty: boolean;
  worktreeDirtyFiles: string[];
  /** Commits the agent made on the branch, newest first. */
  commits: { sha: string; subject: string }[];
  /** The branch is already an ancestor of the target — a merge would be a no-op. */
  alreadyMerged: boolean;
  /** How far the target branch moved since this worktree was created. */
  targetAdvancedBy: number;
}

export function getMergeState(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
}): MergeState {
  const repoAbs = path.resolve(input.repoPath);
  const head = git(["rev-parse", "--abbrev-ref", "HEAD"], repoAbs);
  const repoDirtyFiles = git(["status", "--porcelain"], repoAbs).split("\n").filter(Boolean);
  const worktreeExists = existsSync(input.worktreePath);
  const worktreeDirtyFiles = worktreeExists
    ? git(["status", "--porcelain"], input.worktreePath).split("\n").filter(Boolean)
    : [];

  const log = worktreeExists
    ? git(
        ["log", `--max-count=${MAX_COMMITS}`, "--format=%H%x1f%s", `${input.baseSha}..HEAD`],
        input.worktreePath
      )
    : "";
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\x1f");
      return { sha, subject };
    });

  return {
    targetBranch: head === "HEAD" ? null : head,
    repoClean: repoDirtyFiles.length === 0,
    repoDirtyFiles,
    worktreeDirty: worktreeDirtyFiles.length > 0,
    worktreeDirtyFiles,
    commits,
    alreadyMerged:
      worktreeDirtyFiles.length === 0 &&
      exitCode(["merge-base", "--is-ancestor", input.branch, "HEAD"], repoAbs) === 0,
    targetAdvancedBy: Number(git(["rev-list", "--count", `${input.baseSha}..HEAD`], repoAbs)) || 0,
  };
}

export type MergeBlockedCode =
  | "worktree_missing"
  | "repo_dirty"
  | "detached_head"
  | "nothing_to_merge"
  | "commit_failed"
  | "conflict";

/** A refusal the user can act on (and the UI can explain), as opposed to git blowing up. */
export class MergeBlockedError extends Error {
  readonly code: MergeBlockedCode;
  readonly details: { conflicts?: string[]; files?: string[]; output?: string };

  constructor(
    code: MergeBlockedCode,
    message: string,
    details: { conflicts?: string[]; files?: string[]; output?: string } = {}
  ) {
    super(message);
    this.name = "MergeBlockedError";
    this.code = code;
    this.details = details;
  }
}

export type MergeMode = "merge" | "squash";

export interface MergeResult {
  targetBranch: string;
  mode: MergeMode;
  /** The commit the worktree's uncommitted leftovers were folded into, if there were any. */
  autoCommit: { sha: string; message: string } | null;
  /** Nothing to do — the branch was already in the target. */
  alreadyUpToDate: boolean;
  /** The main checkout's HEAD after the merge. */
  headSha: string;
  output: string;
}

/**
 * Lands the worktree's branch on whatever the main checkout has checked out.
 *
 * Guard rails, in order: the main checkout must be clean (a merge into
 * modified files either refuses halfway or buries the user's own work), the
 * worktree's uncommitted changes are committed first so nothing under review
 * is silently dropped, and a conflicted merge is rolled back rather than left
 * for the user to discover in a shell.
 */
export function mergeWorktree(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  mode?: MergeMode;
  /** Message for both the leftover-changes commit and the merge/squash commit. */
  message: string;
}): MergeResult {
  const repoAbs = path.resolve(input.repoPath);
  const mode = input.mode ?? "merge";

  if (!existsSync(input.worktreePath)) {
    throw new MergeBlockedError(
      "worktree_missing",
      `The worktree is no longer on disk: ${input.worktreePath}`
    );
  }

  const targetBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoAbs);
  if (targetBranch === "HEAD") {
    throw new MergeBlockedError(
      "detached_head",
      "The main checkout is on a detached HEAD — check out a branch there before merging."
    );
  }

  const dirtyRepo = git(["status", "--porcelain"], repoAbs).split("\n").filter(Boolean);
  if (dirtyRepo.length > 0) {
    throw new MergeBlockedError(
      "repo_dirty",
      `${targetBranch} has uncommitted changes — commit or stash them first.`,
      { files: dirtyRepo.slice(0, 20) }
    );
  }

  const autoCommit = commitLeftovers(input.worktreePath, input.message);

  if (exitCode(["merge-base", "--is-ancestor", input.branch, "HEAD"], repoAbs) === 0) {
    return {
      targetBranch,
      mode,
      autoCommit,
      alreadyUpToDate: true,
      headSha: git(["rev-parse", "HEAD"], repoAbs),
      output: `${input.branch} is already part of ${targetBranch}.`,
    };
  }

  let output: string;
  try {
    output =
      mode === "squash"
        ? raw(["merge", "--squash", input.branch], repoAbs)
        : raw(["merge", "--no-ff", "--no-edit", "-m", input.message, input.branch], repoAbs);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"], repoAbs)
      .split("\n")
      .filter(Boolean);
    abortMerge(repoAbs);
    const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    throw new MergeBlockedError(
      "conflict",
      conflicts.length > 0
        ? `Merging ${input.branch} into ${targetBranch} hit conflicts. Nothing was changed — resolve them by hand in the worktree (e.g. rebase it on ${targetBranch}) and try again.`
        : `git merge failed and was rolled back: ${detail || "no output"}`,
      { conflicts, output: detail }
    );
  }

  if (mode === "squash") {
    // --squash only stages the result; without this the "merge" would leave
    // the target branch with a dirty index and no commit.
    if (git(["status", "--porcelain"], repoAbs) === "") {
      throw new MergeBlockedError(
        "nothing_to_merge",
        `Squashing ${input.branch} produced no changes against ${targetBranch}.`
      );
    }
    try {
      output += raw(["commit", "-m", input.message], repoAbs);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      git(["reset", "--hard", "HEAD"], repoAbs);
      throw new MergeBlockedError(
        "commit_failed",
        `The squashed changes could not be committed: ${`${e.stdout ?? ""}${e.stderr ?? ""}`.trim()}`
      );
    }
  }

  return {
    targetBranch,
    mode,
    autoCommit,
    alreadyUpToDate: false,
    headSha: git(["rev-parse", "HEAD"], repoAbs),
    output: output.trim(),
  };
}

/**
 * Commits whatever the agent left uncommitted in the worktree, including
 * untracked files. Without this the review pane would show changes that the
 * merge then silently leaves behind. Shared with the pull-request path, which
 * has the same problem: an unpushed change is an invisible one.
 */
export function commitLeftovers(
  worktreePath: string,
  message: string
): { sha: string; message: string } | null {
  if (git(["status", "--porcelain"], worktreePath) === "") return null;
  const commitMessage = `${message}\n\n[autocode] uncommitted worktree changes, committed at merge time.`;
  try {
    git(["add", "-A"], worktreePath);
    git(["commit", "-m", commitMessage], worktreePath);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new MergeBlockedError(
      "commit_failed",
      `Could not commit the worktree's uncommitted changes: ${
        `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || "git commit failed"
      }`
    );
  }
  return { sha: git(["rev-parse", "HEAD"], worktreePath), message: commitMessage };
}

/**
 * Puts the main checkout back the way it was found. `merge --abort` is the
 * right move for a real merge but has no MERGE_HEAD to work from after a
 * `--squash`, hence the fallbacks — the checkout was verified clean before
 * the merge started, so a hard reset can only throw away the failed merge.
 */
function abortMerge(repoAbs: string): void {
  for (const args of [["merge", "--abort"], ["reset", "--merge"], ["reset", "--hard", "HEAD"]]) {
    if (exitCode(args, repoAbs) === 0) return;
  }
}
