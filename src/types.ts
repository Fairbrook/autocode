export type TaskStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "approved"
  /** Worktree exists; its setup command (pnpm install / uv sync / …) is running. */
  | "setting_up"
  | "implementing"
  | "done"
  | "failed"
  | "cancelled";

export type RunPhase = "planning" | "implementation";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type PlanStatus = "pending" | "approved" | "rejected" | "superseded";
/** Whether this plan version came from the planning agent or from a human editing it. */
export type PlanSource = "planner" | "user_edit";
export type WorktreeStatus = "active" | "retained" | "removed";
/** 'skipped' = no setup command was configured for this project at all. */
export type WorktreeSetupStatus =
  | "skipped"
  | "running"
  | "succeeded"
  | "failed";
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";
export type RememberScope = "once" | "run" | "plan";
export type BackgroundTaskStatus = "running" | "completed" | "killed" | "leaked" | "unknown";

export interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  default_base_ref: string;
  rule_profile: string | null;
  allowed_network_domains: string; // JSON string[]
  /** Shell line run once in every new worktree; null falls back to config.setup.defaultCommand. */
  setup_command: string | null;
  /**
   * 1 lifts the sandbox's Unix-socket block so `docker`/`podman` can reach the
   * daemon. Root-equivalent — see the 005 migration and docs/SANDBOX-FINDINGS.md.
   * Settable only from config/projects.json, never over the HTTP API.
   */
  allow_docker_socket: number;
  /**
   * JSON string[] of hosts whose traffic should go through the sandbox proxy
   * instead of being attempted directly (which cannot work — the sandbox
   * netns has no routes). Merged into the run's allowed domains. See the 006
   * migration and src/filter/proxy-env.ts.
   */
  local_service_hosts: string;
  /**
   * 1 makes the filter engine's `sandboxOverride` rules effective, i.e.
   * build/test, dev-server, playwright and container commands run outside the
   * kernel sandbox with the harness filter as the only boundary. See the 006
   * migration and docs/SANDBOX-FINDINGS.md. config/projects.json only.
   */
  allow_unsandboxed_commands: number;
  enabled: number;
  created_at: string;
}

export interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: number;
  task_id: number;
  phase: RunPhase;
  status: RunStatus;
  model: string;
  cwd: string;
  sdk_session_id: string | null;
  worktree_id: number | null;
  sandbox_config: string; // JSON
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
}

export interface PlanStepJson {
  order: number;
  description: string;
}

export interface ProposedCommandJson {
  pattern: string;
  why: string;
  category: string;
}

export interface ProposedDomainJson {
  domain: string;
  why: string;
}

export interface PlanRow {
  id: number;
  task_id: number;
  run_id: number;
  version: number;
  summary: string;
  task_category: string;
  tdd_applies: number;
  tdd_rationale: string;
  steps_json: string;
  proposed_commands_json: string;
  proposed_domains_json: string;
  risks_json: string;
  files_json: string;
  raw_output_json: string;
  status: PlanStatus;
  approved_at: string | null;
  approval_note: string | null;
  source: PlanSource;
  /** Why the human changed it, if they said. */
  edit_note: string | null;
  /** The version this one replaced; null for the planner's original. */
  supersedes_plan_id: number | null;
}

export interface WorktreeRow {
  id: number;
  task_id: number;
  repo_path: string;
  worktree_path: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  scratch_path: string;
  status: WorktreeStatus;
  setup_command: string | null;
  setup_status: WorktreeSetupStatus;
  setup_exit_code: number | null;
  /** Tail of the setup command's combined stdout+stderr (see SETUP_OUTPUT_LIMIT). */
  setup_output: string | null;
  setup_started_at: string | null;
  setup_ended_at: string | null;
  created_at: string;
  removed_at: string | null;
  /** Set once the branch has been merged into the main checkout — see the 007 migration. */
  merged_at: string | null;
  merge_commit: string | null;
  merge_target_branch: string | null;
}

export interface ApprovalRequestRow {
  id: number;
  run_id: number;
  tool_use_id: string | null;
  tool_name: string;
  title: string | null;
  tool_input_json: string;
  reason: string | null;
  blocked_path: string | null;
  status: ApprovalStatus;
  remember_scope: RememberScope;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface BackgroundTaskRow {
  id: number;
  run_id: number;
  sdk_task_id: string;
  task_type: string | null;
  description: string | null;
  command: string | null;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  status: BackgroundTaskStatus;
  stop_attempted_at: string | null;
  stop_result: string | null;
}

export interface MetricsRow {
  id: number;
  run_id: number;
  phase: RunPhase;
  result_subtype: string | null;
  is_error: number | null;
  stop_reason: string | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  model_usage_json: string | null;
  tool_call_counts_json: string | null;
  filter_allow_count: number;
  filter_deny_count: number;
  filter_ask_count: number;
  sdk_permission_denials: number;
  background_leaked_count: number;
  created_at: string;
}

/** One entry of the agent's own TodoWrite list — the UI's task-list view. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** Present-tense form the agent uses while the item is in_progress ("Adding the rate limiter"). */
  activeForm: string;
}

export interface RunTodosRow {
  run_id: number;
  todos_json: string;
  updated_at: string;
}

export interface RunLogRow {
  id: number;
  run_id: number;
  ts: string;
  seq: number;
  kind: string;
  payload_json: string;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  disabled: number;
  created_at: string;
  password_changed_at: string;
  last_login_at: string | null;
}

export interface SessionRow {
  id: number;
  token_hash: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip: string | null;
}

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  failure_count: number;
  disabled: number;
}
