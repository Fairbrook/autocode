-- A worktree can land either by being merged into the main checkout (007) or
-- by being pushed and proposed as a pull request. The PR is recorded here for
-- the same reason the merge is: once the review pane is closed, nothing on
-- disk connects the task to the pull request that came out of it.
ALTER TABLE worktrees ADD COLUMN pr_url TEXT;

-- Null when the URL didn't carry a number (a GitHub Enterprise path shape we
-- don't recognise); the URL is what the UI actually links to.
ALTER TABLE worktrees ADD COLUMN pr_number INTEGER;

-- The branch the pull request targets. Not the same thing as merge_target_branch:
-- that one is whatever the main checkout happened to have checked out, this one
-- is chosen at review time and lives on the remote.
ALTER TABLE worktrees ADD COLUMN pr_base_branch TEXT;

ALTER TABLE worktrees ADD COLUMN pr_opened_at TEXT;
