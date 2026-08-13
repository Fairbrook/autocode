-- Human edits to a generated plan. Rather than mutating the row the model
-- produced, an edit writes a new version and marks the previous one
-- 'superseded' — the `version` column and the 'superseded' status have been
-- in the schema since 001 for exactly this.
--
-- Keeping both rows preserves the one thing worth auditing here: what the
-- planner actually proposed versus what the human changed before approving
-- it. `getPlanForTask` already returns the newest row, so the rest of the
-- harness sees the current version with no change.
ALTER TABLE plans ADD COLUMN source TEXT NOT NULL DEFAULT 'planner';
ALTER TABLE plans ADD COLUMN edit_note TEXT;
ALTER TABLE plans ADD COLUMN supersedes_plan_id INTEGER REFERENCES plans(id);

CREATE INDEX idx_plans_task_version ON plans(task_id, version);
