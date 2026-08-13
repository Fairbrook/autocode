// Thin fetch wrapper for the autocode API. No framework, no build step.
const BASE = "";

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // The session expired (or was revoked) while the tab was open — there is
  // nothing useful to render, so hand the user back to the login page.
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("Your session has expired.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request("GET", "/api/auth/me"),
  logout: () => request("POST", "/api/auth/logout"),

  listProjects: () => request("GET", "/api/projects"),
  createProject: (body) => request("POST", "/api/projects", body),

  listTasks: () => request("GET", "/api/tasks"),
  getTask: (id) => request("GET", `/api/tasks/${id}`),
  createTask: (body) => request("POST", "/api/tasks", body),

  getPlan: (id) => request("GET", `/api/plans/${id}`),
  revisePlan: (id, plan) => request("POST", `/api/plans/${id}/revise`, plan),
  listPlanVersions: (taskId) => request("GET", `/api/tasks/${taskId}/plans`),
  approvePlan: (id, body) => request("POST", `/api/plans/${id}/approve`, body),
  rejectPlan: (id) => request("POST", `/api/plans/${id}/reject`),
  implementPlan: (id) => request("POST", `/api/plans/${id}/implement`),

  getRun: (id) => request("GET", `/api/runs/${id}`),
  listMetrics: () => request("GET", "/api/metrics"),

  listWorktrees: () => request("GET", "/api/worktrees"),
  getWorktreeDiff: (id) => request("GET", `/api/worktrees/${id}/diff`),
  discardWorktree: (id) => request("POST", `/api/worktrees/${id}/discard`),

  listApprovals: (runId) => request("GET", `/api/approvals${runId ? `?runId=${runId}` : ""}`),
  resolveApproval: (id, body) => request("POST", `/api/approvals/${id}/resolve`, body),

  vapidPublicKey: () => request("GET", "/api/push/vapid-public-key"),
  pushSubscribe: (body) => request("POST", "/api/push/subscribe", body),
};

export function streamRunEvents(runId, onEvent) {
  const source = new EventSource(`/api/runs/${runId}/events`);
  const kinds = [
    "status",
    "system_init",
    "assistant",
    "user",
    "todos",
    "setup_status",
    "setup_output",
    "background_tasks_changed",
    "approval_request",
    "approval_resolved",
    "notification",
    "result",
    "error",
  ];
  for (const kind of kinds) {
    source.addEventListener(kind, (e) => onEvent(kind, JSON.parse(e.data)));
  }
  return source;
}
