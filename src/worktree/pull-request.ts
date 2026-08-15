import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { MergeBlockedError, commitLeftovers, exitCode, git } from "./review.ts";

/**
 * The other way to land a worktree: push its branch and open a pull request,
 * instead of merging into the main checkout. Nothing here touches the user's
 * working tree — the branch already exists, so this is a push plus a `gh pr
 * create` — which makes it the safe option when the main checkout is dirty or
 * the change wants review before it lands.
 *
 * GitHub is reached through the `gh` CLI rather than the REST API on purpose:
 * it already holds the user's credentials (keyring, `gh auth login`, or
 * GH_TOKEN), so the harness never has to store a token of its own.
 */

/** Network calls, so a hung push can't wedge the request forever. */
const NETWORK_TIMEOUT_MS = 120_000;
/**
 * Suggestions only — the base field takes any branch name the user types, so
 * this caps the size of the payload rather than what can be chosen. Generous
 * enough that a normal repo is listed whole (galleon, the busiest one here,
 * has ~490 remote branches).
 */
const MAX_BASE_CANDIDATES = 500;

export type PullRequestBlockedCode =
  | "worktree_missing"
  | "no_remote"
  | "gh_missing"
  | "gh_unauthenticated"
  | "nothing_to_push"
  | "commit_failed"
  | "push_failed"
  | "pr_failed";

/** A refusal the user can act on (and the UI can explain), as opposed to git or gh blowing up. */
export class PullRequestBlockedError extends Error {
  readonly code: PullRequestBlockedCode;
  readonly details: { output?: string };

  constructor(code: PullRequestBlockedCode, message: string, details: { output?: string } = {}) {
    super(message);
    this.name = "PullRequestBlockedError";
    this.code = code;
    this.details = details;
  }
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command to completion and hands back its exit code instead of
 * throwing, because a non-zero `gh` or `git push` is an outcome to report to
 * the user, not an exception. Credential prompts are disabled: this runs on a
 * server with no terminal, so a push that needs a password must fail rather
 * than block.
 */
function run(file: string, args: string[], cwd: string): CommandResult {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      timeout: NETWORK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; code?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? "",
      // A missing binary or a timeout has no stderr of its own; the errno is
      // the only thing that explains what happened.
      stderr: e.stderr ?? (e.code ? `${file}: ${e.code}` : ""),
    };
  }
}

function ghOutput(result: CommandResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

/**
 * A git read whose failure is an answer rather than an error — an unset
 * `origin/HEAD`, a repo with no remotes, a branch that was never pushed. The
 * state below is a best-effort picture used to enable a button, so a missing
 * ref has to come back empty instead of throwing.
 */
function readGit(args: string[], cwd: string): string {
  const result = run("git", args, cwd);
  return result.status === 0 ? result.stdout.trim() : "";
}

export interface PullRequestState {
  /** The `gh` CLI is installed and holds a credential — both are needed to open anything. */
  ghAvailable: boolean;
  ghAuthenticated: boolean;
  /** The remote the branch would be pushed to (`origin` when it exists). */
  remote: string | null;
  remoteUrl: string | null;
  /**
   * Remote branch names to suggest, newest commit first, with `defaultBase`
   * pinned to the front. Suggestions, not the whole set: the field accepts any
   * branch name, and a repo with more than MAX_BASE_CANDIDATES branches is cut
   * off here (see `baseCandidatesTruncated`).
   */
  baseCandidates: string[];
  baseCandidatesTruncated: boolean;
  defaultBase: string | null;
  /** A remote-tracking ref for this branch exists — i.e. it has been pushed at least once. */
  pushed: boolean;
  /** …and it points at the same commit as the worktree's HEAD. Stale until someone fetches. */
  pushUpToDate: boolean;
  commitCount: number;
}

/**
 * Everything the review pane needs to decide whether "open a pull request" is
 * offerable, using only local git state plus a credential lookup — no network
 * calls, so it can ride along with the diff on every review load.
 */
export function getPullRequestState(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseSha: string;
}): PullRequestState {
  const ghAvailable = run("gh", ["--version"], input.repoPath).status === 0;
  // `gh auth token` reads the stored credential (or GH_TOKEN) without calling
  // out to GitHub. The token itself is deliberately not kept or logged.
  const ghAuthenticated = ghAvailable && run("gh", ["auth", "token"], input.repoPath).status === 0;

  const worktreeExists = existsSync(input.worktreePath);
  const cwd = worktreeExists ? input.worktreePath : input.repoPath;

  const remotes = readGit(["remote"], cwd).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;

  if (remote === null) {
    return {
      ghAvailable,
      ghAuthenticated,
      remote: null,
      remoteUrl: null,
      baseCandidates: [],
      baseCandidatesTruncated: false,
      defaultBase: null,
      pushed: false,
      pushUpToDate: false,
      commitCount: 0,
    };
  }

  const prefix = `${remote}/`;
  const branches = readGit(
    // Most recently committed first: on a repo with hundreds of branches, the
    // ones worth targeting are the ones being worked on, and an alphabetical
    // list truncates to whatever happens to sort early.
    ["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", `refs/remotes/${remote}`],
    cwd
  )
    .split("\n")
    .filter(Boolean)
    // `origin/HEAD` is a symref to the default branch, not a branch of its
    // own. It shortens to a bare `origin`, which strips to an empty name.
    .map((ref) => (ref.startsWith(prefix) ? ref.slice(prefix.length) : ""))
    // …and a branch cannot be based on itself.
    .filter((name) => name !== "" && name !== "HEAD" && name !== input.branch);

  // Unset in any repo that wasn't cloned, hence a read that tolerates failure.
  const remoteHead = readGit(
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
    cwd
  );
  // The worktree was branched off base_ref, so that is the branch this change
  // is meant to go back to — unless it isn't on the remote, in which case the
  // remote's default branch is the only sensible guess left.
  const localBase = input.baseRef.startsWith(prefix)
    ? input.baseRef.slice(prefix.length)
    : input.baseRef;
  const defaultBase =
    (branches.includes(localBase) ? localBase : null) ??
    (remoteHead ? remoteHead.slice(prefix.length) : null) ??
    branches[0] ??
    null;

  // The default goes first and is never cut by the cap: it is the one entry
  // the user is most likely to want, and picking it out of a few hundred
  // sorted branches is exactly what a list is bad at.
  const rest = branches.filter((name) => name !== defaultBase);
  const capped = rest.slice(0, MAX_BASE_CANDIDATES);
  const baseCandidates = defaultBase ? [defaultBase, ...capped] : capped;

  const remoteRef = `refs/remotes/${remote}/${input.branch}`;
  const pushed = worktreeExists && exitCode(["rev-parse", "--verify", "--quiet", remoteRef], cwd) === 0;

  return {
    ghAvailable,
    ghAuthenticated,
    remote,
    remoteUrl: readGit(["remote", "get-url", remote], cwd),
    baseCandidates,
    baseCandidatesTruncated: capped.length < rest.length,
    defaultBase,
    pushed,
    pushUpToDate:
      pushed && readGit(["rev-parse", remoteRef], cwd) === readGit(["rev-parse", "HEAD"], cwd),
    commitCount: worktreeExists
      ? Number(readGit(["rev-list", "--count", `${input.baseSha}..HEAD`], cwd)) || 0
      : 0,
  };
}

export interface PullRequestResult {
  url: string;
  number: number | null;
  base: string;
  branch: string;
  remote: string;
  draft: boolean;
  /** The commit the worktree's uncommitted leftovers were folded into, if there were any. */
  autoCommit: { sha: string; message: string } | null;
  /** A PR for this branch was already open — the push updated it instead of a new one being created. */
  alreadyExisted: boolean;
  output: string;
}

/**
 * Pushes the worktree's branch and opens a pull request against `base`.
 *
 * Ordering matters: uncommitted work is committed first (same rule as the
 * merge path — what the review pane showed is what gets proposed), then the
 * branch is pushed, and only then is the PR opened. A branch that already has
 * an open PR is not a failure: the push has updated it, so the existing PR is
 * handed back instead.
 */
export function openPullRequest(input: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  /** Message for the leftover-changes commit. */
  commitMessage: string;
}): PullRequestResult {
  if (!existsSync(input.worktreePath)) {
    throw new PullRequestBlockedError(
      "worktree_missing",
      `The worktree is no longer on disk: ${input.worktreePath}`
    );
  }
  if (run("gh", ["--version"], input.worktreePath).status !== 0) {
    throw new PullRequestBlockedError(
      "gh_missing",
      "Opening a pull request needs the GitHub CLI (`gh`) on the server's PATH."
    );
  }
  if (run("gh", ["auth", "token"], input.worktreePath).status !== 0) {
    throw new PullRequestBlockedError(
      "gh_unauthenticated",
      "The GitHub CLI has no credentials — run `gh auth login` (or set GH_TOKEN) for the user running autocode."
    );
  }

  const remotes = git(["remote"], input.worktreePath).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) {
    throw new PullRequestBlockedError(
      "no_remote",
      `${input.repoPath} has no git remote to push to.`
    );
  }

  const autoCommit = commitAnyLeftovers(input.worktreePath, input.commitMessage);

  const commitCount =
    Number(git(["rev-list", "--count", `${input.baseSha}..HEAD`], input.worktreePath)) || 0;
  if (commitCount === 0) {
    throw new PullRequestBlockedError(
      "nothing_to_push",
      `${input.branch} has no commits of its own — there is nothing to open a pull request for.`
    );
  }

  const push = run(
    "git",
    ["push", "--set-upstream", remote, `${input.branch}:${input.branch}`],
    input.worktreePath
  );
  if (push.status !== 0) {
    throw new PullRequestBlockedError(
      "push_failed",
      `Pushing ${input.branch} to ${remote} failed: ${ghOutput(push) || "no output"}`,
      { output: ghOutput(push) }
    );
  }

  const existing = findOpenPullRequest(input.worktreePath, input.branch);
  if (existing) {
    return {
      url: existing.url,
      number: existing.number,
      base: existing.base || input.base,
      branch: input.branch,
      remote,
      draft: existing.draft,
      autoCommit,
      alreadyExisted: true,
      output: `${input.branch} already has an open pull request; the push updated it.`,
    };
  }

  const created = run(
    "gh",
    [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body",
      input.body,
      ...(input.draft ? ["--draft"] : []),
    ],
    input.worktreePath
  );
  if (created.status !== 0) {
    throw new PullRequestBlockedError(
      "pr_failed",
      `The branch was pushed, but \`gh pr create\` failed: ${ghOutput(created) || "no output"}`,
      { output: ghOutput(created) }
    );
  }

  const url = firstUrl(created.stdout);
  if (!url) {
    throw new PullRequestBlockedError(
      "pr_failed",
      `The branch was pushed and \`gh pr create\` reported success, but printed no pull request URL: ${
        ghOutput(created) || "no output"
      }`,
      { output: ghOutput(created) }
    );
  }

  return {
    url,
    number: numberFromUrl(url),
    base: input.base,
    branch: input.branch,
    remote,
    draft: Boolean(input.draft),
    autoCommit,
    alreadyExisted: false,
    output: ghOutput(created),
  };
}

/** Same commit-the-leftovers rule as the merge path, re-labelled for this one's error type. */
function commitAnyLeftovers(
  worktreePath: string,
  message: string
): { sha: string; message: string } | null {
  try {
    return commitLeftovers(worktreePath, message);
  } catch (err) {
    if (err instanceof MergeBlockedError) {
      throw new PullRequestBlockedError("commit_failed", err.message);
    }
    throw err;
  }
}

/**
 * The open PR for a branch, if there is one. Failures are treated as "none
 * found" on purpose: this is a courtesy lookup, and `gh pr create` will report
 * a real problem in its own words a moment later.
 */
function findOpenPullRequest(
  cwd: string,
  branch: string
): { url: string; number: number | null; base: string; draft: boolean } | null {
  const listed = run(
    "gh",
    ["pr", "list", "--head", branch, "--state", "open", "--limit", "1",
     "--json", "number,url,baseRefName,isDraft"],
    cwd
  );
  if (listed.status !== 0) return null;
  try {
    const [pr] = JSON.parse(listed.stdout || "[]") as {
      number?: number;
      url?: string;
      baseRefName?: string;
      isDraft?: boolean;
    }[];
    if (!pr?.url) return null;
    return {
      url: pr.url,
      number: pr.number ?? null,
      base: pr.baseRefName ?? "",
      draft: Boolean(pr.isDraft),
    };
  } catch {
    return null;
  }
}

/** `gh pr create` prints the URL on its own line, after any progress chatter. */
function firstUrl(out: string): string | null {
  return out.split(/\s+/).find((token) => /^https?:\/\//.test(token)) ?? null;
}

function numberFromUrl(url: string): number | null {
  const match = url.match(/\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}
