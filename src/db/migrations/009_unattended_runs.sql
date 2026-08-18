-- Unattended mode: the user has said, for this run, that every tool call the
-- filter engine would have stopped to ask about should be allowed without
-- them. It lives on the run rather than in memory so that a page reload (or a
-- second tab) shows the real state, and so the run_log records which calls
-- were allowed by a human and which by this flag.
--
-- It only removes the human from the "ask" tier. Rules that deny a command,
-- the write roots and the sandbox's network allowlist are all unchanged — an
-- unattended run cannot do anything an attended one couldn't be talked into.
ALTER TABLE runs ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0;
