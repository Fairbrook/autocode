import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorktreeOnDisk, type CreatedWorktree } from "../../src/worktree/manager.ts";
import {
  getPullRequestState,
  openPullRequest,
  PullRequestBlockedError,
} from "../../src/worktree/pull-request.ts";

/**
 * The remote is a bare repo on disk and `gh` is a shell script on PATH, so the
 * push is real (the branch genuinely lands in another repository) while the
 * GitHub half is observable: the fake records the argv it was called with.
 */

let base: string;
let remotePath: string;
let repoPath: string;
let worktreeRoot: string;
let binDir: string;
let ghLog: string;
let wt: CreatedWorktree;
let originalPath: string | undefined;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): void {
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", message], cwd);
}

/** Every argv the fake `gh` was invoked with, one call per line. */
function ghCalls(): string[][] {
  if (!existsSync(ghLog)) return [];
  return readFileSync(ghLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(""));
}

function writeFakeGh(options: { authenticated?: boolean; prList?: string } = {}): void {
  const script = `#!/bin/sh
printf '%s' "$1" >> "$GH_LOG"
for arg in "$@"; do
  if [ "$arg" != "$1" ]; then printf '\\037%s' "$arg" >> "$GH_LOG"; fi
done
printf '\\n' >> "$GH_LOG"

case "$1" in
  --version) echo "gh version 0.0.0-fake"; exit 0 ;;
  auth) [ "${options.authenticated === false ? "1" : "0"}" = "1" ] && exit 1; echo "fake-token"; exit 0 ;;
esac

case "$2" in
  list) echo '${options.prList ?? "[]"}'; exit 0 ;;
  create) echo "https://github.com/acme/widgets/pull/42"; exit 0 ;;
esac
exit 1
`;
  writeFileSync(path.join(binDir, "gh"), script, { mode: 0o755 });
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-pr-test-"));
  remotePath = path.join(base, "remote.git");
  repoPath = path.join(base, "repo");
  worktreeRoot = path.join(base, "worktrees");
  binDir = path.join(base, "bin");
  ghLog = path.join(base, "gh-calls.log");
  mkdirSync(binDir, { recursive: true });

  git(["init", "-q", "--bare", "--initial-branch=main", remotePath], base);
  git(["init", "-q", "--initial-branch=main", repoPath], base);
  git(["config", "user.email", "test@example.com"], repoPath);
  git(["config", "user.name", "Test"], repoPath);
  writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  commit(repoPath, "initial");
  git(["remote", "add", "origin", remotePath], repoPath);
  git(["push", "-q", "-u", "origin", "main"], repoPath);

  wt = createWorktreeOnDisk({
    repoPath,
    taskId: 7,
    taskTitle: "propose me",
    baseRef: "HEAD",
    worktreeRoot,
  });

  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.GH_LOG = ghLog;
  writeFakeGh();
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.GH_LOG;
  rmSync(base, { recursive: true, force: true });
});

function state() {
  return getPullRequestState({
    repoPath,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    baseRef: "main",
    baseSha: wt.baseSha,
  });
}

function open(overrides: Partial<Parameters<typeof openPullRequest>[0]> = {}) {
  return openPullRequest({
    repoPath,
    worktreePath: wt.worktreePath,
    branch: wt.branch,
    baseSha: wt.baseSha,
    base: "main",
    title: "Propose me",
    body: "Body text.",
    commitMessage: "Propose me",
    ...overrides,
  });
}

describe("getPullRequestState", () => {
  it("reports the remote, its branches and how much there is to push", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nagain\n");
    commit(wt.worktreePath, "a change");

    const s = state();

    expect(s.ghAvailable).toBe(true);
    expect(s.ghAuthenticated).toBe(true);
    expect(s.remote).toBe("origin");
    expect(s.remoteUrl).toBe(remotePath);
    expect(s.baseCandidates).toContain("main");
    expect(s.defaultBase).toBe("main");
    expect(s.commitCount).toBe(1);
    // Nothing has been pushed yet, so there is no remote-tracking ref for it.
    expect(s.pushed).toBe(false);
  });

  it("puts the default base first and never offers the HEAD symref", () => {
    git(["branch", "feature-x"], repoPath);
    git(["push", "-q", "origin", "feature-x"], repoPath);
    // What a clone has and `git remote add` doesn't: origin/HEAD, which
    // shortens to a bare "origin" and is not a branch anyone can target.
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoPath);

    const s = state();

    expect(s.defaultBase).toBe("main");
    expect(s.baseCandidates[0]).toBe("main");
    expect(s.baseCandidates).toContain("feature-x");
    expect(s.baseCandidates).not.toContain("");
    expect(s.baseCandidates).not.toContain("HEAD");
    expect(s.baseCandidatesTruncated).toBe(false);
  });

  it("caps the suggestions without ever cutting the default base", () => {
    // A repo the size of a busy one: alphabetically, "main" is nowhere near
    // the front of this, which is exactly how it used to go missing.
    const sha = git(["rev-parse", "HEAD"], repoPath);
    execFileSync("git", ["update-ref", "--stdin"], {
      cwd: repoPath,
      input: Array.from({ length: 520 }, (_, i) => `create refs/remotes/origin/zz-${i} ${sha}\n`).join(""),
    });

    const s = state();

    expect(s.baseCandidatesTruncated).toBe(true);
    expect(s.baseCandidates).toHaveLength(501);
    expect(s.baseCandidates[0]).toBe("main");
    expect(new Set(s.baseCandidates).size).toBe(s.baseCandidates.length);
  });

  it("never offers the branch as a base for itself", () => {
    git(["push", "-q", "origin", wt.branch], wt.worktreePath);
    git(["fetch", "-q", "origin"], repoPath);

    expect(state().baseCandidates).not.toContain(wt.branch);
  });

  it("reports gh as unauthenticated when it holds no credential", () => {
    writeFakeGh({ authenticated: false });

    const s = state();
    expect(s.ghAvailable).toBe(true);
    expect(s.ghAuthenticated).toBe(false);
  });
});

describe("openPullRequest", () => {
  it("commits leftovers, pushes the branch and opens the pull request", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nagain\n");
    commit(wt.worktreePath, "a change");
    // Left uncommitted by the agent — the review pane showed it, so it has to
    // be part of what gets proposed.
    writeFileSync(path.join(wt.worktreePath, "extra.txt"), "not committed\n");

    const result = open();

    expect(result.url).toBe("https://github.com/acme/widgets/pull/42");
    expect(result.number).toBe(42);
    expect(result.base).toBe("main");
    expect(result.alreadyExisted).toBe(false);
    expect(result.autoCommit).not.toBeNull();

    // The branch really is on the remote, with the leftover file in it.
    const pushed = git(["rev-parse", `refs/heads/${wt.branch}`], remotePath);
    expect(pushed).toBe(git(["rev-parse", "HEAD"], wt.worktreePath));
    expect(git(["show", `${pushed}:extra.txt`], remotePath)).toBe("not committed");

    const create = ghCalls().find((call) => call[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--base");
    expect(create?.[create.indexOf("--base") + 1]).toBe("main");
    expect(create?.[create.indexOf("--head") + 1]).toBe(wt.branch);
    expect(create?.[create.indexOf("--title") + 1]).toBe("Propose me");
    expect(create).not.toContain("--draft");
  });

  it("passes --draft through", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "draft me\n");
    commit(wt.worktreePath, "a change");

    expect(open({ draft: true }).draft).toBe(true);
    expect(ghCalls().find((call) => call[1] === "create")).toContain("--draft");
  });

  it("pushes to the existing pull request rather than opening a second one", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nagain\n");
    commit(wt.worktreePath, "a change");
    writeFakeGh({
      prList: '[{"number":7,"url":"https://github.com/acme/widgets/pull/7","baseRefName":"main","isDraft":false}]',
    });

    const result = open();

    expect(result.alreadyExisted).toBe(true);
    expect(result.number).toBe(7);
    expect(ghCalls().some((call) => call[1] === "create")).toBe(false);
    // The point of pushing anyway: the open PR now has the new commit.
    expect(git(["rev-parse", `refs/heads/${wt.branch}`], remotePath)).toBe(
      git(["rev-parse", "HEAD"], wt.worktreePath)
    );
  });

  it("refuses a branch with nothing on it", () => {
    expect(() => open()).toThrow(PullRequestBlockedError);
    try {
      open();
    } catch (err) {
      expect((err as PullRequestBlockedError).code).toBe("nothing_to_push");
    }
    expect(ghCalls().some((call) => call[1] === "create")).toBe(false);
  });

  it("refuses to push when gh has no credential", () => {
    writeFileSync(path.join(wt.worktreePath, "README.md"), "hello\nagain\n");
    commit(wt.worktreePath, "a change");
    writeFakeGh({ authenticated: false });

    try {
      open();
      throw new Error("expected a PullRequestBlockedError");
    } catch (err) {
      expect((err as PullRequestBlockedError).code).toBe("gh_unauthenticated");
    }
    // Nothing was published — the credential check happens before the push.
    expect(() => git(["rev-parse", `refs/heads/${wt.branch}`], remotePath)).toThrow();
  });
});
