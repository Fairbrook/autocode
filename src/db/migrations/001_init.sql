CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_path TEXT NOT NULL UNIQUE,
  default_base_ref TEXT NOT NULL DEFAULT 'HEAD',
  rule_profile TEXT,
  allowed_network_domains TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worktrees (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  repo_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  scratch_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  sdk_session_id TEXT,
  worktree_id INTEGER REFERENCES worktrees(id),
  sandbox_config TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT,
  error TEXT
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  version INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  task_category TEXT NOT NULL,
  tdd_applies INTEGER NOT NULL,
  tdd_rationale TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  proposed_commands_json TEXT NOT NULL,
  proposed_domains_json TEXT NOT NULL,
  risks_json TEXT NOT NULL DEFAULT '[]',
  files_json TEXT NOT NULL DEFAULT '[]',
  raw_output_json TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_at TEXT,
  approval_note TEXT
);

CREATE TABLE approved_command_rules (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  pattern TEXT NOT NULL,
  category TEXT,
  note TEXT,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approved_network_domains (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  domain TEXT NOT NULL,
  note TEXT,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approval_requests (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  tool_use_id TEXT,
  tool_name TEXT NOT NULL,
  title TEXT,
  tool_input_json TEXT NOT NULL,
  reason TEXT,
  blocked_path TEXT,
  status TEXT NOT NULL,
  remember_scope TEXT NOT NULL DEFAULT 'once',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT
);

CREATE TABLE background_tasks (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  sdk_task_id TEXT NOT NULL,
  task_type TEXT,
  description TEXT,
  command TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  stop_attempted_at TEXT,
  stop_result TEXT,
  UNIQUE(run_id, sdk_task_id)
);

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),
  phase TEXT NOT NULL,
  result_subtype TEXT,
  is_error INTEGER,
  stop_reason TEXT,
  duration_ms INTEGER,
  duration_api_ms INTEGER,
  num_turns INTEGER,
  total_cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  model_usage_json TEXT,
  tool_call_counts_json TEXT,
  filter_allow_count INTEGER NOT NULL DEFAULT 0,
  filter_deny_count INTEGER NOT NULL DEFAULT 0,
  filter_ask_count INTEGER NOT NULL DEFAULT 0,
  sdk_permission_denials INTEGER NOT NULL DEFAULT 0,
  background_leaked_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE tool_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  ts TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  decision TEXT NOT NULL,
  rule_id TEXT,
  layer TEXT,
  segment TEXT,
  reason TEXT,
  duration_ms INTEGER
);

CREATE TABLE run_log (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  ts TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX idx_run_log_run_seq ON run_log(run_id, seq);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
