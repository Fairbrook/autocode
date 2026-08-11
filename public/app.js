import { api, streamRunEvents } from "/api.js";

const app = document.getElementById("app");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function badge(status) {
  return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
}

function fmtCost(usd) {
  return usd == null ? "—" : `$${Number(usd).toFixed(4)}`;
}

// ---------- Router ----------
async function router() {
  const hash = location.hash.slice(1) || "/";
  try {
    if (hash === "/") return renderHome();
    if (hash === "/history") return renderHistory();
    const taskMatch = hash.match(/^\/tasks\/(\d+)$/);
    if (taskMatch) return renderTask(Number(taskMatch[1]));
    app.innerHTML = `<p class="error-text">Unknown route.</p>`;
  } catch (err) {
    app.innerHTML = `<div class="card"><p class="error-text">${esc(err.message)}</p></div>`;
  }
}
window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", () => {
  router();
  setupSession();
  setupPushSubscription();
});

// ---------- Session ----------
async function setupSession() {
  const logoutBtn = document.getElementById("logout");
  logoutBtn?.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    try {
      await api.logout();
    } finally {
      location.href = "/login.html";
    }
  });
  try {
    const { username } = await api.me();
    const el = document.getElementById("session-user");
    if (el && username) el.textContent = username;
  } catch {
    // A 401 has already redirected to the login page; nothing else to do.
  }
}

// ---------- Home: project/task submit + task list ----------
async function renderHome() {
  const [projects, tasks] = await Promise.all([api.listProjects(), api.listTasks()]);

  app.innerHTML = `
    <div class="card">
      <h2>New task</h2>
      <label>Project</label>
      <select id="project-select">
        ${projects.map((p) => `<option value="${p.id}">${esc(p.name)} — ${esc(p.repo_path)}</option>`).join("")}
        <option value="__new__">+ Register a new project…</option>
      </select>
      <div id="new-project-fields" style="display:none">
        <label>Project name</label>
        <input id="np-name" placeholder="my-project" />
        <label>Repository path (absolute)</label>
        <input id="np-path" placeholder="/home/you/projects/my-project" />
        <label>Setup command <span class="muted">(optional — runs once in every new worktree)</span></label>
        <input id="np-setup" placeholder="pnpm install --frozen-lockfile" />
      </div>
      <label>Task title</label>
      <input id="task-title" placeholder="Add a rate limiter to the API" />
      <label>Task description</label>
      <textarea id="task-desc" placeholder="Describe what you want done. The planning agent will explore the repo and propose an approach."></textarea>
      <div class="row" style="margin-top:0.75rem">
        <button class="primary" id="submit-task">Submit for planning</button>
        <span id="submit-status" class="muted"></span>
      </div>
    </div>
    <div class="card">
      <h2>Tasks</h2>
      ${tasks.length === 0 ? `<p class="muted">No tasks yet.</p>` : `
        <table>
          <thead><tr><th>Title</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            ${tasks.map((t) => `
              <tr style="cursor:pointer" onclick="location.hash='#/tasks/${t.id}'">
                <td>${esc(t.title)}</td>
                <td>${badge(t.status)}</td>
                <td class="muted">${new Date(t.updated_at).toLocaleString()}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;

  document.getElementById("project-select").addEventListener("change", (e) => {
    document.getElementById("new-project-fields").style.display = e.target.value === "__new__" ? "block" : "none";
  });

  document.getElementById("submit-task").addEventListener("click", async () => {
    const status = document.getElementById("submit-status");
    const title = document.getElementById("task-title").value.trim();
    const description = document.getElementById("task-desc").value.trim();
    if (!title || !description) {
      status.textContent = "Title and description are required.";
      return;
    }
    let projectId = document.getElementById("project-select").value;
    status.textContent = "Submitting…";
    try {
      if (projectId === "__new__") {
        const name = document.getElementById("np-name").value.trim();
        const repoPath = document.getElementById("np-path").value.trim();
        if (!name || !repoPath) {
          status.textContent = "Project name and path are required.";
          return;
        }
        const setupCommand = document.getElementById("np-setup").value.trim() || null;
        const project = await api.createProject({ name, repoPath, setupCommand });
        projectId = project.id;
      }
      const { task } = await api.createTask({ projectId: Number(projectId), title, description });
      location.hash = `#/tasks/${task.id}`;
    } catch (err) {
      status.textContent = err.message;
    }
  });
}

// ---------- History ----------
async function renderHistory() {
  const metrics = await api.listMetrics();
  app.innerHTML = `
    <div class="card">
      <h2>Run history</h2>
      ${metrics.length === 0 ? `<p class="muted">No completed runs yet.</p>` : `
        <table>
          <thead><tr><th>Run</th><th>Phase</th><th>Result</th><th>Cost</th><th>Turns</th><th>Filter (allow/ask/deny)</th><th>Leaked bg</th></tr></thead>
          <tbody>
            ${metrics.map((m) => `
              <tr>
                <td><a href="#/tasks/${m.task_id}">#${m.run_id}</a></td>
                <td>${esc(m.phase)}</td>
                <td>${badge(m.result_subtype || "unknown")}</td>
                <td>${fmtCost(m.total_cost_usd)}</td>
                <td>${m.num_turns ?? "—"}</td>
                <td>${m.filter_allow_count}/${m.filter_ask_count}/${m.filter_deny_count}</td>
                <td>${m.background_leaked_count > 0 ? `<span class="error-text">${m.background_leaked_count}</span>` : "0"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}

// ---------- Task detail ----------
let activeStream = null;

async function renderTask(taskId) {
  if (activeStream) { activeStream.close(); activeStream = null; }

  const { task, runs, plan } = await api.getTask(taskId);

  // runs are ordered newest-first, so this is the current attempt.
  const implRun = runs.find((r) => r.phase === "implementation");
  // Detail carries the pieces the task endpoint doesn't: the agent's task
  // list and the worktree's setup state.
  const detail = implRun ? await api.getRun(implRun.id) : null;
  const live = Boolean(implRun && (implRun.status === "running" || implRun.status === "queued"));
  const planSteps = plan ? JSON.parse(plan.steps_json) : [];

  let body = "";
  if (plan && plan.status === "pending") {
    body = renderPlanReview(plan);
  } else if (plan && (plan.status === "approved") && task.status === "approved") {
    body = `
      <div class="card">
        <h2>Plan approved</h2>
        <p>${esc(plan.summary)}</p>
        <button class="primary" id="start-impl">Start implementation</button>
      </div>
    `;
  } else if (task.status === "failed") {
    // The failure could have happened during planning (no implementation
    // run exists yet), during worktree setup, or during implementation.
    const failedRun = runs.find((r) => r.status === "failed") || runs[0];
    body = renderSetupCard(detail?.worktree, false) + renderFailure(failedRun);
  } else if (task.status === "setting_up" || task.status === "implementing" || task.status === "done") {
    body = renderRunView(implRun, detail, planSteps, live);
  } else {
    body = `<div class="card"><p class="muted">Planning in progress…</p></div>`;
  }

  app.innerHTML = `
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">${esc(task.title)}</h2>
        ${badge(task.status)}
      </div>
      <p class="muted">${esc(task.description)}</p>
    </div>
    ${body}
  `;

  if (plan && plan.status === "pending") wirePlanReview(plan);
  const startBtn = document.getElementById("start-impl");
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      startBtn.textContent = "Starting…";
      try {
        await api.implementPlan(plan.id);
        renderTask(taskId);
      } catch (err) {
        alert(err.message);
        startBtn.disabled = false;
      }
    });
  }

  if (implRun && (live || task.status === "setting_up" || task.status === "implementing")) {
    wireLiveRun(implRun.id, planSteps, detail?.todos ?? null);
  }
}

function renderPlanReview(plan) {
  const steps = JSON.parse(plan.steps_json);
  const commands = JSON.parse(plan.proposed_commands_json);
  const domains = JSON.parse(plan.proposed_domains_json);
  const risks = JSON.parse(plan.risks_json || "[]");

  return `
    <div class="card">
      <h2>Plan ready for review</h2>
      <p>${esc(plan.summary)}</p>
      <p><strong>Category:</strong> ${esc(plan.task_category)} &nbsp; <strong>TDD applies:</strong> ${plan.tdd_applies ? "yes" : "no"}</p>
      <p class="muted">${esc(plan.tdd_rationale)}</p>

      <h3>Steps</h3>
      <ol>${steps.sort((a, b) => a.order - b.order).map((s) => `<li>${esc(s.description)}</li>`).join("")}</ol>

      ${risks.length ? `<h3>Risks</h3><ul>${risks.map((r) => `<li class="muted">${esc(r)}</li>`).join("")}</ul>` : ""}

      <h3>Proposed commands <span class="muted">(edit before approving)</span></h3>
      <div id="commands-list">
        ${commands.map((c, i) => commandRow(c.pattern, c.category, i)).join("")}
      </div>
      <button id="add-command">+ Add command</button>

      <h3>Proposed network domains</h3>
      <div id="domains-list">
        ${domains.map((d, i) => domainRow(d.domain, i)).join("")}
      </div>
      <button id="add-domain">+ Add domain</button>

      <div class="row" style="margin-top:1rem">
        <button class="primary" id="approve-plan">Approve &amp; continue</button>
        <button class="danger" id="reject-plan">Reject</button>
      </div>
    </div>
  `;
}

function commandRow(pattern, category, i) {
  return `<div class="command-row" data-row>
    <input value="${esc(pattern)}" data-pattern />
    <input value="${esc(category || "")}" placeholder="category" data-category />
    <span class="muted">proposed</span>
    <button data-remove>✕</button>
  </div>`;
}
function domainRow(domain, i) {
  return `<div class="domain-row" data-row>
    <input value="${esc(domain)}" data-domain />
    <span class="muted">proposed</span>
    <button data-remove>✕</button>
  </div>`;
}

function wirePlanReview(plan) {
  const commandsList = document.getElementById("commands-list");
  const domainsList = document.getElementById("domains-list");

  commandsList.addEventListener("click", (e) => {
    if (e.target.matches("[data-remove]")) e.target.closest("[data-row]").remove();
  });
  domainsList.addEventListener("click", (e) => {
    if (e.target.matches("[data-remove]")) e.target.closest("[data-row]").remove();
  });
  document.getElementById("add-command").addEventListener("click", () => {
    commandsList.insertAdjacentHTML("beforeend", commandRow("", "user_added"));
  });
  document.getElementById("add-domain").addEventListener("click", () => {
    domainsList.insertAdjacentHTML("beforeend", domainRow(""));
  });

  document.getElementById("reject-plan").addEventListener("click", async () => {
    if (!confirm("Reject this plan? The task will be cancelled.")) return;
    await api.rejectPlan(plan.id);
    router();
  });

  document.getElementById("approve-plan").addEventListener("click", async (e) => {
    e.target.disabled = true;
    const commands = [...commandsList.querySelectorAll("[data-row]")].map((row) => ({
      pattern: row.querySelector("[data-pattern]").value.trim(),
      category: row.querySelector("[data-category]").value.trim() || undefined,
      origin: "proposed",
    })).filter((c) => c.pattern);
    const domains = [...domainsList.querySelectorAll("[data-row]")].map((row) => ({
      domain: row.querySelector("[data-domain]").value.trim(),
      origin: "proposed",
    })).filter((d) => d.domain);

    try {
      await api.approvePlan(plan.id, { commands, domains });
      router();
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
    }
  });
}

function renderFailure(run) {
  if (!run) {
    return `<div class="card"><p class="muted">Task failed, but no run record was found — check the server log.</p></div>`;
  }
  return `
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">${esc(run.phase === "planning" ? "Planning" : "Implementation")} failed</h2>
        <span class="muted">run #${run.id} · ${esc(run.model)}</span>
      </div>
      <pre class="log" style="white-space:pre-wrap">${esc(run.error || "(no error message was recorded for this run)")}</pre>
    </div>
  `;
}

/**
 * The worktree's setup command (pnpm install / uv sync / …). When the run is
 * live the output pane starts empty and is filled by the SSE replay, which
 * already carries every setup_output event from seq 0 — rendering the stored
 * tail as well would double it.
 */
function renderSetupCard(worktree, live) {
  if (!worktree || worktree.setup_status === "skipped") return "";
  return `
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">Environment setup</h3>
        <span id="setup-badge">${badge(worktree.setup_status)}</span>
      </div>
      <div class="setup-command">${esc(worktree.setup_command || "")}</div>
      <pre class="log" id="setup-log">${live ? "" : esc(worktree.setup_output || "")}</pre>
    </div>
  `;
}

/**
 * The agent's own TodoWrite list — what it's doing right now, in its words.
 * Until the agent posts its first list the approved plan's steps stand in,
 * so the panel is never empty while the user waits.
 */
function renderTodoList(todos, planSteps) {
  const fromAgent = Array.isArray(todos) && todos.length > 0;
  const items = fromAgent
    ? todos.map((t) => ({
        label: t.status === "in_progress" ? t.activeForm || t.content : t.content,
        status: t.status,
      }))
    : (planSteps || [])
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((s) => ({ label: s.description, status: "pending" }));

  if (items.length === 0) {
    return `<p class="muted">No task list yet.</p>`;
  }

  const done = items.filter((i) => i.status === "completed").length;
  const marks = { completed: "✓", in_progress: "▸", pending: "○" };
  return `
    <div class="row between">
      <span class="muted">${fromAgent ? "Reported by the agent" : "From the approved plan — the agent will replace this with its own list"}</span>
      <span class="muted">${done}/${items.length} done</span>
    </div>
    <div class="progress"><div class="progress-fill" style="width:${items.length ? (done / items.length) * 100 : 0}%"></div></div>
    <ul class="todo-list">
      ${items.map((i) => `
        <li class="todo ${esc(i.status)}">
          <span class="todo-mark">${marks[i.status] || "○"}</span>
          <span class="todo-text">${esc(i.label)}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderRunView(run, detail, planSteps, live) {
  if (!run) return `<div class="card"><p class="muted">Waiting for the implementation run to start…</p></div>`;
  return `
    ${renderSetupCard(detail?.worktree, live)}
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">Implementation ${badge(run.status)}</h2>
        <span class="muted">run #${run.id} · ${esc(run.model)}</span>
      </div>
      <h3>Task list</h3>
      <div id="todo-area">${renderTodoList(detail?.todos, planSteps)}</div>
      <div id="approvals-area"></div>
      <div id="metrics-area"></div>
      <h3>Live log</h3>
      <div class="log" id="run-log"></div>
    </div>
  `;
}

async function wireLiveRun(runId, planSteps, initialTodos) {
  const logEl = document.getElementById("run-log");
  const approvalsEl = document.getElementById("approvals-area");
  const todoEl = document.getElementById("todo-area");
  const setupLogEl = document.getElementById("setup-log");
  const setupBadgeEl = document.getElementById("setup-badge");
  if (!logEl) return;

  let todos = initialTodos;

  function appendLog(kind, payload) {
    const div = document.createElement("div");
    div.className = "entry";
    div.innerHTML = `<span class="kind">[${esc(kind)}]</span> ${esc(summarize(kind, payload))}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function summarize(kind, payload) {
    if (kind === "assistant" || kind === "user") {
      const blocks = payload.content || [];
      return blocks.map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_use") return `→ ${b.name}(${JSON.stringify(b.input).slice(0, 120)})`;
        if (b.type === "tool_result") return `← ${JSON.stringify(b.content).slice(0, 120)}`;
        return b.type;
      }).join(" ");
    }
    if (kind === "status") return payload.status;
    if (kind === "result") return `${payload.subtype} (cost: ${fmtCost(payload.total_cost_usd)})`;
    if (kind === "notification") return `${payload.title}: ${payload.body}`;
    if (kind === "todos") {
      const active = payload.todos.find((t) => t.status === "in_progress");
      const done = payload.todos.filter((t) => t.status === "completed").length;
      return `${done}/${payload.todos.length} — ${active ? active.activeForm || active.content : "no item in progress"}`;
    }
    if (kind === "setup_status") {
      return payload.status === "running"
        ? `running \`${payload.command}\``
        : `${payload.status}${payload.exitCode != null ? ` (exit ${payload.exitCode})` : ""}${payload.timedOut ? " — timed out" : ""}`;
    }
    return JSON.stringify(payload).slice(0, 200);
  }

  function applySetupOutput(text) {
    if (!setupLogEl) return;
    setupLogEl.textContent += text;
    setupLogEl.scrollTop = setupLogEl.scrollHeight;
  }

  function applyTodos(next) {
    todos = next;
    if (todoEl) todoEl.innerHTML = renderTodoList(todos, planSteps);
  }

  async function refreshApprovals() {
    const pending = await api.listApprovals(runId);
    approvalsEl.innerHTML = pending.map((a) => `
      <div class="approval-card" data-id="${a.id}">
        <div class="row between">
          <strong>${esc(a.tool_name)} needs your approval</strong>
        </div>
        <div class="command">${esc(JSON.parse(a.tool_input_json).command || JSON.stringify(JSON.parse(a.tool_input_json)))}</div>
        ${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ""}
        <div class="row" style="margin-top:0.5rem">
          <button class="primary" data-allow="${a.id}">Allow</button>
          <button class="danger" data-deny="${a.id}">Deny</button>
        </div>
      </div>
    `).join("");

    approvalsEl.querySelectorAll("[data-allow]").forEach((btn) =>
      btn.addEventListener("click", () => resolveApproval(btn.dataset.allow, "allow"))
    );
    approvalsEl.querySelectorAll("[data-deny]").forEach((btn) =>
      btn.addEventListener("click", () => resolveApproval(btn.dataset.deny, "deny"))
    );
  }

  async function resolveApproval(id, decision) {
    const note = decision === "deny" ? prompt("Optional note for why you're denying this:") ?? "" : "";
    await api.resolveApproval(id, { decision, note });
    refreshApprovals();
  }

  await refreshApprovals();

  activeStream = streamRunEvents(runId, (kind, payload) => {
    // Setup output has its own pane — echoing every install line into the
    // run log would bury the agent's actual work.
    if (kind === "setup_output") {
      applySetupOutput(payload.text);
      return;
    }
    appendLog(kind, payload);
    if (kind === "todos") applyTodos(payload.todos);
    if (kind === "setup_status" && setupBadgeEl) setupBadgeEl.innerHTML = badge(payload.status);
    if (kind === "approval_request" || kind === "approval_resolved") refreshApprovals();
    if (kind === "status" && (payload.status === "completed" || payload.status === "failed")) {
      setTimeout(() => router(), 500);
    }
  });
}

// ---------- Web Push subscription (best-effort, silently no-ops if unsupported) ----------
async function setupPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const existing = await reg.pushManager.getSubscription();
    if (existing) return;
    if (Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
    }
    if (Notification.permission !== "granted") return;
    const { publicKey } = await api.vapidPublicKey();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api.pushSubscribe(sub.toJSON());
  } catch {
    // Push is a best-effort third channel — never block the app on it.
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
