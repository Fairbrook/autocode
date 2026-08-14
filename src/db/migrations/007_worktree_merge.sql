-- Landing a worktree in the main checkout is the one action in the harness
-- that touches the user's own repository, so the fact that it happened is
-- recorded on the worktree row rather than inferred from git afterwards: once
-- the branch is merged and the worktree removed, nothing on disk says which
-- task produced which commit.
ALTER TABLE worktrees ADD COLUMN merged_at TEXT;

-- The main checkout's HEAD right after the merge (the merge commit, or the
-- squash commit). Lets the UI point at what landed.
ALTER TABLE worktrees ADD COLUMN merge_commit TEXT;

-- Which branch it landed on. Not derivable later: the main checkout can be on
-- a different branch by the time anyone looks, and it need not be the
-- worktree's base_ref.
ALTER TABLE worktrees ADD COLUMN merge_target_branch TEXT;
