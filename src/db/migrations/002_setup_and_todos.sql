-- Per-project worktree setup command (`pnpm install`, `uv sync`, …), run
-- once inside a freshly created worktree so the implementation agent starts
-- with dependencies already installed. NULL means "fall back to the global
-- config default"; the resolved command is copied onto the worktree row so
-- the record of what actually ran survives later config edits.
ALTER TABLE projects ADD COLUMN setup_command TEXT;

ALTER TABLE worktrees ADD COLUMN setup_command TEXT;
ALTER TABLE worktrees ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'skipped';
ALTER TABLE worktrees ADD COLUMN setup_exit_code INTEGER;
ALTER TABLE worktrees ADD COLUMN setup_output TEXT;
ALTER TABLE worktrees ADD COLUMN setup_started_at TEXT;
ALTER TABLE worktrees ADD COLUMN setup_ended_at TEXT;

-- Latest TodoWrite state per run — REPLACE semantics (the tool always sends
-- the whole list), so one row per run is the complete picture. The
-- append-only history of every intermediate list still lives in run_log
-- under kind='todos'; this table is just the "what is it doing right now"
-- lookup the UI reads on page load.
CREATE TABLE run_todos (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id),
  todos_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
