# Reviewing a worktree and merging it back

Every task's work lands on its own branch in its own `git worktree`, off to
the side of the repository you actually work in. Review and merge is the step
that brings it home.

Review is the last step on the task page's timeline (Plan → Setup →
Implementation → Review). It unlocks as soon as the implementation run stops —
including when it *failed*, because a half-finished branch is often exactly
what you want to look at. The page follows the task's current step by default;
clicking a step pins it in the URL (`#/tasks/12/review`) so you can read back
through earlier ones without the page jumping ahead of you.

## What the diff shows

One patch per file, for the whole branch, not per commit:

- the agent's commits are collapsed together, so what you read is the net
  change a merge would introduce, not the route it took to get there;
- uncommitted changes count (the diff is `base..working tree`), because a run
  that ends without committing is normal;
- untracked files are included, diffed against `/dev/null`;
- renames are detected; binary files are flagged instead of diffed; a single
  file's patch is capped at 200 KB.

The changed files are a sidebar next to the diff on a wide screen, and stack
above it on a narrow one. `A`/`M`/`D`/`R`/`U` on each row is the git status
letter (`U` = untracked), followed by the file's own +/− counts.

## Merging

The merge target is **whatever branch the main checkout currently has checked
out** — not the worktree's `base_ref`, which may be months old by the time you
look. The button names the target so there's no guessing.

Two modes: a merge commit (`git merge --no-ff`, the default — the branch stays
visible in history) or a squash into one commit.

Guard rails, all of which turn into a 409 the UI explains rather than a
half-finished merge in your working tree:

| Situation | What happens |
| --- | --- |
| Main checkout has uncommitted changes | Refused (`repo_dirty`) — commit or stash first |
| Main checkout on a detached HEAD | Refused (`detached_head`) |
| Worktree has uncommitted changes | Committed on the branch first, so nothing under review is silently dropped |
| The merge conflicts | Rolled back (`git merge --abort`), conflicting files named (`conflict`) |
| Branch is already in the target | No-op, reported as already up to date |

Conflicts are yours to resolve: rebase or merge inside the worktree, then come
back and merge again. The harness never leaves conflict markers in your own
checkout.

"Remove the worktree after merging" deletes the worktree, its scratch dir and
the branch. The commits survive on the target branch, and dropping the branch
keeps a later retry of the same task from colliding with the old branch name.

## Opening a pull request instead

The review panel has two tabs: **Merge locally** and **Open a pull request**.
The second pushes the branch to the repository's remote and opens a PR against
a base branch you pick, without touching your main checkout at all — which is
why it stays available when merging is blocked (a dirty checkout, a detached
HEAD, or a change you'd rather have reviewed before it lands). The panel opens
on whichever tab is actually usable.

GitHub is reached through the **`gh` CLI**, so autocode never stores a token of
its own: whatever `gh auth login` (or `GH_TOKEN`) set up for the user running
the server is what gets used. The review pane checks for `gh` and for a stored
credential locally — `gh auth token`, no network call — and explains which one
is missing rather than offering a button that fails.

The base branch is a searchable field, not a dropdown: a repo can have
hundreds of remote branches, so it suggests them newest-commit-first with the
default pinned to the top, filters as you type, and still accepts any branch
name you write — including one this clone hasn't fetched. It defaults to the
worktree's `base_ref` when the remote still has it and to the remote's default
branch (`origin/HEAD`) otherwise. Title and description default to the task's;
both are editable, and the PR can be opened as a draft.

Order of operations, and the refusals (all 409s the UI explains):

| Situation | What happens |
| --- | --- |
| Worktree has uncommitted changes | Committed on the branch first, same rule as merging |
| Branch has no commits of its own | Refused (`nothing_to_push`) |
| No `gh` / no credential / no remote | Refused (`gh_missing`, `gh_unauthenticated`, `no_remote`) |
| The push fails (diverged remote branch, no access) | Refused (`push_failed`) with git's own output |
| The branch already has an open PR | The push updates it; the existing PR is reported back |

Nothing is force-pushed and nothing is merged: the branch, the worktree and
the task's status are left exactly as they were, minus the leftovers commit.

## Where it's recorded

A merge writes `worktrees.merged_at`, `merge_commit` and
`merge_target_branch` (migration 007), and the worktree's status becomes
`retained` — still on disk, no longer the live workspace.

A pull request writes `worktrees.pr_url`, `pr_number`, `pr_base_branch` and
`pr_opened_at` (migration 008) and deliberately leaves the status alone: the
branch hasn't landed anywhere yet, and more commits may well be pushed onto
the same PR. The task list shows a `pr #n` badge in place of `unmerged` once
one is open.

## API

- `GET /api/worktrees/:id/changes` → `{ worktree, files, stat, merge, pullRequest }`,
  where `merge` carries the target branch, cleanliness of both sides, the
  branch's commits, whether it is already merged, and how far the target has
  moved since the worktree was created; and `pullRequest` carries the remote,
  its branches (suggestions, capped at 500 and flagged with
  `baseCandidatesTruncated`), the default base, whether the branch is already
  pushed, and whether `gh` is installed and holds a credential.
- `POST /api/worktrees/:id/merge` with `{ mode?, message?, removeWorktree? }`.
- `POST /api/worktrees/:id/pull-request` with `{ base?, title?, body?, draft? }`.
- `POST /api/worktrees/:id/discard` is still the "throw it away" path.
