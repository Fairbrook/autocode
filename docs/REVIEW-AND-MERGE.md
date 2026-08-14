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

## Where it's recorded

`worktrees.merged_at`, `merge_commit` and `merge_target_branch` (migration
007). Once merged, the worktree's status becomes `retained` — still on disk,
no longer the live workspace.

## API

- `GET /api/worktrees/:id/changes` → `{ worktree, files, stat, merge }`, where
  `merge` carries the target branch, cleanliness of both sides, the branch's
  commits, whether it is already merged, and how far the target has moved
  since the worktree was created.
- `POST /api/worktrees/:id/merge` with `{ mode?, message?, removeWorktree? }`.
- `POST /api/worktrees/:id/discard` is still the "throw it away" path.
