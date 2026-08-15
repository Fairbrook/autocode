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

/**
 * `done` only means the implementation run stopped cleanly — the branch is
 * still sitting in its worktree until someone merges it. That gap is easy to
 * lose track of once the task drops down the list, so it gets its own badge
 * alongside the status. A discarded or already-merged worktree has nothing
 * left to land, and neither does a task that never got that far.
 */
function unmergedBadge(task, worktree) {
  if (task.status !== "done" || !worktree) return "";
  if (worktree.merged_at || worktree.status === "removed") return "";
  // A pull request is the same gap — the branch hasn't landed — but it is
  // waiting on a review somewhere else, not on the user noticing it here.
  if (worktree.pr_url) {
    return `<span class="badge pr-open" title="${esc(worktree.pr_url)}">pr ${esc(worktree.pr_number ? `#${worktree.pr_number}` : "open")}</span>`;
  }
  return `<span class="badge unmerged" title="The implementation finished but ${esc(worktree.branch)} has not been merged yet">unmerged</span>`;
}

function fmtCost(usd) {
  return usd == null ? "—" : `$${Number(usd).toFixed(4)}`;
}

// ---------- Router ----------
async function router() {
  const hash = location.hash.slice(1) || "/";
  app.className = "";
  try {
    if (hash === "/") return renderHome();
    if (hash === "/history") return renderHistory();
    // The optional trailing segment is the step the user pinned on the task
    // timeline (`#/tasks/12/review`); without it the page follows whatever
    // step the task is actually on.
    const taskMatch = hash.match(/^\/tasks\/(\d+)(?:\/([a-z]+))?$/);
    if (taskMatch) return renderTask(Number(taskMatch[1]), taskMatch[2]);
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

/** Canonical task lifecycle order, so the status filter reads as a progression. */
const TASK_STATUSES = [
  "draft", "planning", "awaiting_approval", "approved",
  "setting_up", "implementing", "done", "failed", "cancelled",
];

async function renderHome() {
  // Worktrees come along so a finished-but-unmerged task is visible from the
  // list itself, without opening it. They arrive newest-first, so the first
  // match for a task is its current attempt.
  const [projects, tasks, worktrees] = await Promise.all([
    api.listProjects(),
    api.listTasks(),
    api.listWorktrees(),
  ]);

  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? `project #${id}`;
  // Only statuses that actually occur, so the dropdown can't offer a choice
  // that filters everything away.
  const presentStatuses = TASK_STATUSES.filter((s) => tasks.some((t) => t.status === s));

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
        <div class="filter-bar">
          <input id="task-search" type="search" placeholder="Search tasks…" aria-label="Search tasks" />
          <select id="filter-project" aria-label="Filter by project">
            <option value="">All projects</option>
            ${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
          </select>
          <select id="filter-status" aria-label="Filter by status">
            <option value="">All statuses</option>
            ${presentStatuses.map((s) => `<option value="${esc(s)}">${esc(s.replace(/_/g, " "))}</option>`).join("")}
          </select>
        </div>
        <table>
          <thead><tr><th>Title</th><th>Project</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody id="task-rows"></tbody>
        </table>
        <p id="task-empty" class="muted" hidden>No tasks match these filters.</p>
      `}
    </div>
  `;

  if (tasks.length > 0) setupTaskFilters({ tasks, worktrees, projectName });

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

/**
 * Filtering happens here rather than on the server: the list is small enough to
 * hold in the page, and redrawing only the rows keeps whatever the user is
 * typing (and its focus) intact between keystrokes.
 */
function setupTaskFilters({ tasks, worktrees, projectName }) {
  const search = document.getElementById("task-search");
  const project = document.getElementById("filter-project");
  const status = document.getElementById("filter-status");
  const rows = document.getElementById("task-rows");
  const empty = document.getElementById("task-empty");

  function draw() {
    const q = search.value.trim().toLowerCase();
    const visible = tasks.filter((t) => {
      if (project.value && String(t.project_id) !== project.value) return false;
      if (status.value && t.status !== status.value) return false;
      if (!q) return true;
      // The description isn't in the table, but it is what the user wrote, so
      // searching it finds tasks whose title alone wouldn't match.
      return [t.title, t.description, projectName(t.project_id)]
        .some((field) => String(field ?? "").toLowerCase().includes(q));
    });

    rows.innerHTML = visible.map((t) => `
      <tr style="cursor:pointer" onclick="location.hash='#/tasks/${t.id}'">
        <td>${esc(t.title)}</td>
        <td class="muted">${esc(projectName(t.project_id))}</td>
        <td>${badge(t.status)} ${unmergedBadge(t, worktrees.find((w) => w.task_id === t.id))}</td>
        <td class="muted">${new Date(t.updated_at).toLocaleString()}</td>
      </tr>
    `).join("");
    empty.hidden = visible.length > 0;
  }

  search.addEventListener("input", draw);
  project.addEventListener("change", draw);
  status.addEventListener("change", draw);
  draw();
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

/** A task moves through these in order; the timeline is one entry per key. */
const STEP_KEYS = ["plan", "setup", "implementation", "review"];

/** The step pinned in the URL (`#/tasks/12/review`), or null when the page should follow the task. */
function pinnedStep() {
  const m = location.hash.slice(1).match(/^\/tasks\/\d+\/([a-z]+)$/);
  return m ? m[1] : null;
}

/** Navigates to a step. Passing null unpins, so the page follows the task again. */
function goToTask(taskId, step) {
  const next = `#/tasks/${taskId}${step ? `/${step}` : ""}`;
  // Assigning an unchanged hash fires no hashchange, so re-render directly.
  if (location.hash === next) renderTask(taskId, step ?? undefined);
  else location.hash = next;
}

async function renderTask(taskId, requestedStep) {
  if (activeStream) { activeStream.close(); activeStream = null; }

  const { task, runs, plan } = await api.getTask(taskId);

  // runs are ordered newest-first, so this is the current attempt.
  const implRun = runs.find((r) => r.phase === "implementation") ?? null;
  const planRun = runs.find((r) => r.phase === "planning") ?? null;
  // Detail carries the pieces the task endpoint doesn't: the agent's task
  // list and the worktree's setup state.
  const detail = implRun ? await api.getRun(implRun.id) : null;
  const live = Boolean(implRun && (implRun.status === "running" || implRun.status === "queued"));

  const ctx = {
    taskId,
    task,
    runs,
    plan,
    planSteps: plan ? JSON.parse(plan.steps_json) : [],
    implRun,
    planRun,
    detail,
    worktree: detail?.worktree ?? null,
    live,
    // The planner can stop to ask a question, so the plan step needs the same
    // live channel the implementation step has.
    planLive: Boolean(planRun && (planRun.status === "running" || planRun.status === "queued")),
  };
  // Whether this render will attach the SSE stream. Panes that the stream
  // fills (the run log, the setup output) must not also render their stored
  // copy, because a fresh connection replays the whole log from seq 0.
  ctx.streaming = Boolean(
    implRun && (live || task.status === "setting_up" || task.status === "implementing")
  );

  const steps = buildSteps(ctx);
  const progressKey = progressStepKey(ctx, steps);
  const requested = steps.find((s) => s.key === requestedStep && s.available);
  ctx.step = requested ? requested.key : progressKey;

  // The review step wants the room: file sidebar plus diff.
  app.className = ctx.step === "review" ? "wide" : "";
  app.innerHTML = `
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">${esc(task.title)}</h2>
        <span class="row" style="gap:0.4rem">
          ${badge(task.status)}
          ${unmergedBadge(task, ctx.worktree)}
        </span>
      </div>
      <p class="muted">${esc(task.description)}</p>
    </div>
    ${renderTimeline(steps, progressKey, ctx.step)}
    <div id="step-panel">${renderStep(ctx)}</div>
  `;

  document.getElementById("timeline").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-step]");
    if (btn && !btn.disabled) goToTask(taskId, btn.dataset.step);
  });
  wireStep(ctx);
}

/**
 * The four steps, each with whether it can be opened yet and a one-word
 * subtitle. A step is available once the thing it shows exists — going back
 * to a finished step is always allowed, jumping ahead to one that hasn't
 * happened is not.
 */
function buildSteps(ctx) {
  const { task, plan, implRun, worktree, live } = ctx;
  const planningFailed = task.status === "failed" && !implRun;
  const setupFailed = worktree?.setup_status === "failed";

  return [
    {
      key: "plan",
      label: "Plan",
      sub: plan
        ? plan.status === "pending"
          ? "needs review"
          : plan.status
        : planningFailed
          ? "failed"
          : "planning…",
      available: true,
      failed: planningFailed,
    },
    {
      key: "setup",
      label: "Setup",
      sub: worktree ? worktree.setup_status : "not started",
      available: Boolean(worktree),
      failed: Boolean(setupFailed),
    },
    {
      key: "implementation",
      label: "Implementation",
      sub: implRun ? implRun.status : "not started",
      available: Boolean(implRun),
      failed: task.status === "failed" && Boolean(implRun) && !setupFailed,
    },
    {
      key: "review",
      label: "Review",
      sub: !worktree
        ? "no worktree"
        : worktree.merged_at
          ? "merged"
          : worktree.status === "removed"
            ? "discarded"
            : live
              ? "waiting"
              : "ready",
      // A stopped run is reviewable even if it failed — a half-finished
      // branch is often exactly what the user wants to look at.
      available: Boolean(worktree) && !live && worktree.status !== "removed",
      failed: false,
    },
  ];
}

/** Where the task actually is right now — the step shown unless the user pinned another. */
function progressStepKey(ctx, steps) {
  const { task, implRun, worktree } = ctx;
  let wanted = "plan";
  if (task.status === "done") wanted = "review";
  else if (task.status === "setting_up") wanted = "setup";
  else if (task.status === "implementing") wanted = "implementation";
  else if (task.status === "failed") {
    wanted = worktree?.setup_status === "failed" ? "setup" : implRun ? "implementation" : "plan";
  }
  // Fall back down the timeline if that step can't be opened (e.g. a merged
  // task whose worktree has since been removed).
  for (let i = STEP_KEYS.indexOf(wanted); i > 0; i--) {
    if (steps[i].available) return steps[i].key;
  }
  return steps[STEP_KEYS.indexOf(wanted)]?.available ? wanted : "plan";
}

/**
 * Two things are drawn at once: how far the task has got (dot fill and the
 * connector between dots) and which step the user is looking at (the
 * highlighted pill). They're usually the same step, but not while the user
 * is reading back through earlier ones.
 */
function renderTimeline(steps, progressKey, selectedKey) {
  const progressIndex = STEP_KEYS.indexOf(progressKey);
  return `
    <nav class="timeline" id="timeline">
      ${steps.map((s, i) => {
        const state = s.failed
          ? "failed"
          : i < progressIndex ? "done" : i === progressIndex ? "active" : "todo";
        const mark = s.failed ? "✕" : state === "done" ? "✓" : String(i + 1);
        return `
          <button class="tl-step ${state}${s.key === selectedKey ? " selected" : ""}"
                  data-step="${s.key}" ${s.available ? "" : "disabled"}
                  title="${esc(s.available ? s.label : `${s.label} — not reached yet`)}">
            <span class="tl-dot">${mark}</span>
            <span class="tl-label">${esc(s.label)}</span>
            <span class="tl-sub">${esc(s.sub)}</span>
          </button>
        `;
      }).join("")}
    </nav>
  `;
}

function renderStep(ctx) {
  if (ctx.step === "plan") return renderPlanStep(ctx);
  if (ctx.step === "setup") return renderSetupStep(ctx);
  if (ctx.step === "implementation") return renderImplementationStep(ctx);
  return renderReviewStep(ctx);
}

function wireStep(ctx) {
  const { step, taskId, plan, implRun } = ctx;

  if (step === "plan") {
    if (plan?.status === "pending") wirePlanReview(plan);
    const startBtn = document.getElementById("start-impl");
    startBtn?.addEventListener("click", async () => {
      startBtn.disabled = true;
      startBtn.textContent = "Starting…";
      try {
        await api.implementPlan(plan.id);
        goToTask(taskId, null); // follow the task into setup
      } catch (err) {
        alert(err.message);
        startBtn.disabled = false;
        startBtn.textContent = "Start implementation";
      }
    });
  }

  if (step === "setup" || step === "implementation") wireRetry(ctx);

  if ((step === "setup" || step === "implementation") && ctx.streaming) {
    wireLiveRun(implRun.id, ctx);
  }

  // A planner that stopped to ask something is blocked until it's answered,
  // so the plan step watches its run for approval requests — and follows the
  // task on to the finished plan when the run ends.
  if (step === "plan" && ctx.planLive && ctx.planRun) {
    wireLiveRun(ctx.planRun.id, ctx);
  }

  if (step === "review" && ctx.worktree && !ctx.live && ctx.worktree.status !== "removed") {
    wireReview(ctx.worktree, ctx.task);
  }
}

// ---------- Step: plan ----------
function renderPlanStep(ctx) {
  const { plan, task, runs } = ctx;
  if (!plan) {
    if (task.status === "failed") return renderFailure(runs.find((r) => r.phase === "planning"));
    return `
      <div class="card">
        <p class="muted">Planning in progress…</p>
      </div>
      <div id="approvals-area"></div>
    `;
  }
  if (plan.status === "pending") return renderPlanReview(plan);

  const canStart = plan.status === "approved" && task.status === "approved";
  return renderPlanSummary(
    plan,
    canStart
      ? `<div class="row" style="margin-top:1rem">
           <button class="primary" id="start-impl">Start implementation</button>
           <span class="muted">Creates a worktree and installs the project's dependencies.</span>
         </div>`
      : ""
  );
}

/** Read-only view of a plan that is no longer editable — what was agreed, for looking back at. */
function renderPlanSummary(plan, footer) {
  const steps = JSON.parse(plan.steps_json).sort((a, b) => a.order - b.order);
  const risks = JSON.parse(plan.risks_json || "[]");
  const files = JSON.parse(plan.files_json || "[]");
  return `
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">Plan</h2>
        <span class="muted">v${plan.version}${plan.source === "user_edit" ? " · edited by you" : ""} ${badge(plan.status)}</span>
      </div>
      <p>${esc(plan.summary)}</p>
      <p class="muted">
        ${esc(plan.task_category)} · TDD ${plan.tdd_applies ? "applies" : "does not apply"} — ${esc(plan.tdd_rationale)}
      </p>
      ${plan.approval_note ? `<p class="muted">Note on approval: “${esc(plan.approval_note)}”</p>` : ""}
      <h3>Steps</h3>
      <ol class="plan-list">${steps.map((s) => `<li>${esc(s.description)}</li>`).join("")}</ol>
      ${risks.length ? `<h3>Risks</h3><ul class="plan-list">${risks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${files.length ? `<h3>Files expected to change</h3><ul class="plan-list mono">${files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      ${footer || ""}
    </div>
  `;
}

// ---------- Step: setup ----------
function renderSetupStep(ctx) {
  const { worktree, implRun, plan, streaming } = ctx;
  if (!worktree) {
    return `<div class="card"><p class="muted">No worktree yet — approve the plan and start the implementation first.</p></div>`;
  }
  const failed = worktree.setup_status === "failed";
  return `
    ${renderWorktreeCard(worktree)}
    ${worktree.setup_status === "skipped"
      ? `<div class="card">
           <h3>Environment setup</h3>
           <p class="muted">No setup command is configured for this project, so the agent started straight away.</p>
         </div>`
      : renderSetupCard(worktree, streaming)}
    ${failed ? renderFailure(implRun) : ""}
    ${failed ? renderRetryCard(plan, worktree, "setup") : ""}
  `;
}

/**
 * Neither failure is usually the plan's fault — setup fails on the
 * environment (a stale lockfile, a missing toolchain, no network), and an
 * implementation that ran out of turns or hit a transient error was working
 * from a plan the user already agreed to. So both offer the same escape
 * hatch: run that same plan again in a fresh worktree, instead of sending
 * the user back through planning.
 *
 * The difference is what happens to the attempt being abandoned. A failed
 * setup leaves nothing worth keeping — the agent never ran — so the server
 * discards that worktree as part of the retry. A failed implementation may
 * have committed real work, so its branch survives by default and only goes
 * away if the user asks for it.
 */
function renderRetryCard(plan, worktree, phase) {
  if (plan?.status !== "approved") return "";
  const setup = phase === "setup";
  return `
    <div class="card">
      <h3 style="margin-top:0">Try again</h3>
      <p class="muted">
        ${setup
          ? `Fix the environment (or the project's setup command), then run plan v${plan.version}
             again in a new worktree. The failed one is discarded.`
          : `Run plan v${plan.version} again in a new worktree off
             <code>${esc(worktree.base_ref)}</code>, with setup from scratch — nothing this
             attempt did carries over.`}
      </p>
      ${setup
        ? ""
        : `<label class="inline">
             <input type="checkbox" id="retry-discard" />
             Discard this attempt's worktree and branch <code>${esc(worktree.branch)}</code> first
           </label>
           <p class="muted">Otherwise it stays on disk, reachable through git but no longer shown here.</p>`}
      <div class="row">
        <button class="primary" id="retry-run">Retry with the same plan</button>
        <span class="muted" id="retry-status"></span>
      </div>
    </div>
  `;
}

/**
 * Same endpoint the "Start implementation" button uses: it already treats a
 * second call as a new attempt (fresh worktree, fresh branch, setup from
 * scratch), so a retry is just that call again with the plan unchanged.
 */
function wireRetry(ctx) {
  const btn = document.getElementById("retry-run");
  if (!btn) return;
  const statusEl = document.getElementById("retry-status");
  const discardEl = document.getElementById("retry-discard");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    statusEl.className = "muted";
    try {
      // Before the new attempt, not after: two worktrees for one task is
      // exactly the state this checkbox exists to avoid, and if the discard
      // fails the user still has the branch they asked to be rid of.
      if (discardEl?.checked) {
        statusEl.textContent = "Discarding this attempt…";
        await api.discardWorktree(ctx.worktree.id);
      }
      statusEl.textContent = "Starting a new attempt…";
      await api.implementPlan(ctx.plan.id);
      goToTask(ctx.taskId, null); // unpin, so the page follows the new attempt
    } catch (err) {
      statusEl.className = "error-text";
      statusEl.textContent = err.message;
      btn.disabled = false;
    }
  });
}

function renderWorktreeCard(worktree) {
  return `
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">Worktree</h3>
        ${badge(worktree.status)}
      </div>
      <dl class="kv">
        <dt>Branch</dt><dd>${esc(worktree.branch)}</dd>
        <dt>Path</dt><dd>${esc(worktree.worktree_path)}</dd>
        <dt>Base</dt><dd>${esc(worktree.base_ref)} @ ${esc((worktree.base_sha || "").slice(0, 8))}</dd>
        ${worktree.merged_at
          ? `<dt>Merged</dt><dd>into ${esc(worktree.merge_target_branch || "?")} at ${esc((worktree.merge_commit || "").slice(0, 8))}</dd>`
          : ""}
        ${worktree.pr_url
          ? `<dt>Pull request</dt><dd><a href="${esc(worktree.pr_url)}" target="_blank" rel="noreferrer">${esc(worktree.pr_number ? `#${worktree.pr_number}` : worktree.pr_url)}</a> → ${esc(worktree.pr_base_branch || "?")}</dd>`
          : ""}
      </dl>
    </div>
  `;
}

// ---------- Step: implementation ----------
function renderImplementationStep(ctx) {
  const { implRun, detail, planSteps, streaming, task, worktree, plan } = ctx;
  if (!implRun) {
    return `<div class="card"><p class="muted">The implementation hasn't started yet.</p></div>`;
  }
  // A failed setup is reported on its own step; repeating it here would
  // blame the agent for something that happened before it ran.
  const failedHere = task.status === "failed" && worktree?.setup_status !== "failed";
  return `
    ${failedHere ? renderFailure(implRun) : ""}
    ${failedHere && worktree ? renderRetryCard(plan, worktree, "implementation") : ""}
    ${renderRunView(implRun, detail, planSteps, streaming)}
  `;
}

// ---------- Step: review ----------
function renderReviewStep(ctx) {
  const { worktree, live } = ctx;
  if (!worktree) {
    return `<div class="card"><p class="muted">There is nothing to review yet.</p></div>`;
  }
  if (worktree.status === "removed") {
    return `
      <div class="card">
        <p class="muted">
          This worktree was ${worktree.merged_at
            ? `merged into <code>${esc(worktree.merge_target_branch || "?")}</code> and removed`
            : "discarded"} — there is nothing left to review.
        </p>
      </div>
    `;
  }
  if (live) {
    return `<div class="card"><p class="muted">The implementation is still running — the diff appears once it stops.</p></div>`;
  }
  return reviewCardShell(worktree);
}

function renderPlanReview(plan) {
  const steps = JSON.parse(plan.steps_json).sort((a, b) => a.order - b.order);
  const commands = JSON.parse(plan.proposed_commands_json);
  const domains = JSON.parse(plan.proposed_domains_json);
  const risks = JSON.parse(plan.risks_json || "[]");
  const files = JSON.parse(plan.files_json || "[]");

  return `
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">Plan ready for review</h2>
        <span class="muted">
          v${plan.version}${plan.source === "user_edit" ? " · edited by you" : ""}
          ${plan.version > 1 ? `· <a href="#" id="show-history">history</a>` : ""}
        </span>
      </div>
      <p class="muted">Everything below is editable — change it here instead of asking for a new plan.</p>
      <div id="plan-history" class="plan-history" hidden></div>

      <label for="plan-summary">Summary</label>
      <textarea id="plan-summary" rows="2">${esc(plan.summary)}</textarea>

      <div class="plan-meta">
        <div>
          <label for="plan-category">Category</label>
          <input id="plan-category" value="${esc(plan.task_category)}" />
        </div>
        <div>
          <label for="plan-tdd">TDD applies</label>
          <select id="plan-tdd">
            <option value="yes" ${plan.tdd_applies ? "selected" : ""}>yes</option>
            <option value="no" ${plan.tdd_applies ? "" : "selected"}>no</option>
          </select>
        </div>
      </div>
      <label for="plan-tdd-rationale">TDD rationale</label>
      <input id="plan-tdd-rationale" value="${esc(plan.tdd_rationale)}" />

      <h3>Steps</h3>
      <div id="steps-list">${steps.map((s) => stepRow(s.description)).join("")}</div>
      <button id="add-step">+ Add step</button>

      <h3>Risks</h3>
      <div id="risks-list">${risks.map((r) => textRow(r, "risk", "Something that could go wrong")).join("")}</div>
      <button id="add-risk">+ Add risk</button>

      <h3>Files expected to change</h3>
      <div id="files-list">${files.map((f) => textRow(f, "file", "src/some/file.ts")).join("")}</div>
      <button id="add-file">+ Add file</button>

      <h3>Proposed commands</h3>
      <div id="commands-list">
        ${commands.map((c, i) => commandRow(c.pattern, c.category, i)).join("")}
      </div>
      <button id="add-command">+ Add command</button>

      <h3>Proposed network domains</h3>
      <div id="domains-list">
        ${domains.map((d, i) => domainRow(d.domain, i)).join("")}
      </div>
      <button id="add-domain">+ Add domain</button>

      <label for="plan-note">Note on your changes <span class="muted">(optional, passed to the agent)</span></label>
      <input id="plan-note" placeholder="e.g. use the existing retry helper instead of adding one" />

      <div class="row" style="margin-top:1rem">
        <button class="primary" id="approve-plan">Approve &amp; continue</button>
        <button id="save-plan">Save changes</button>
        <button class="danger" id="reject-plan">Reject</button>
        <span class="muted" id="plan-status"></span>
      </div>
    </div>
  `;
}

function stepRow(description) {
  return `<div class="step-row" data-row>
    <span class="step-handle">⋮⋮</span>
    <input value="${esc(description)}" data-step placeholder="What the agent should do" />
    <button data-up title="Move up">↑</button>
    <button data-down title="Move down">↓</button>
    <button data-remove title="Remove">✕</button>
  </div>`;
}

function textRow(value, kind, placeholder) {
  return `<div class="text-row" data-row>
    <input value="${esc(value)}" data-${kind} placeholder="${esc(placeholder)}" />
    <button data-remove title="Remove">✕</button>
  </div>`;
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
  const stepsList = document.getElementById("steps-list");
  const risksList = document.getElementById("risks-list");
  const filesList = document.getElementById("files-list");
  const commandsList = document.getElementById("commands-list");
  const domainsList = document.getElementById("domains-list");
  const statusEl = document.getElementById("plan-status");

  // Every list behaves the same: ✕ removes a row, and steps also reorder.
  for (const list of [stepsList, risksList, filesList, commandsList, domainsList]) {
    list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-row]");
      if (!row) return;
      if (e.target.matches("[data-remove]")) row.remove();
      if (e.target.matches("[data-up]") && row.previousElementSibling) {
        row.parentNode.insertBefore(row, row.previousElementSibling);
      }
      if (e.target.matches("[data-down]") && row.nextElementSibling) {
        row.parentNode.insertBefore(row.nextElementSibling, row);
      }
    });
  }

  const addTo = (list, html, focus) => {
    list.insertAdjacentHTML("beforeend", html);
    if (focus) list.lastElementChild.querySelector("input")?.focus();
  };
  document.getElementById("add-step").addEventListener("click", () => addTo(stepsList, stepRow(""), true));
  document.getElementById("add-risk").addEventListener("click", () => addTo(risksList, textRow("", "risk", "Something that could go wrong"), true));
  document.getElementById("add-file").addEventListener("click", () => addTo(filesList, textRow("", "file", "src/some/file.ts"), true));
  document.getElementById("add-command").addEventListener("click", () => addTo(commandsList, commandRow("", "user_added"), true));
  document.getElementById("add-domain").addEventListener("click", () => addTo(domainsList, domainRow(""), true));

  document.getElementById("show-history")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const box = document.getElementById("plan-history");
    box.hidden = !box.hidden;
    if (box.hidden || box.dataset.loaded) return;
    const versions = await api.listPlanVersions(plan.task_id);
    box.innerHTML = versions
      .map((v) => `
        <div class="plan-history-entry">
          <strong>v${v.version}</strong>
          <span class="muted">${v.source === "user_edit" ? "your edit" : "planning agent"} · ${esc(v.status)}</span>
          ${v.edit_note ? `<div class="muted">“${esc(v.edit_note)}”</div>` : ""}
          <ol>${JSON.parse(v.steps_json).sort((a, b) => a.order - b.order).map((s) => `<li class="muted">${esc(s.description)}</li>`).join("")}</ol>
        </div>
      `)
      .join("");
    box.dataset.loaded = "1";
  });

  /** The whole editable form, in the shape the revise/approve endpoints take. */
  function collectPlanEdits() {
    const values = (list, attr) =>
      [...list.querySelectorAll(`[data-${attr}]`)].map((i) => i.value.trim()).filter(Boolean);
    return {
      summary: document.getElementById("plan-summary").value,
      taskCategory: document.getElementById("plan-category").value,
      tddApplies: document.getElementById("plan-tdd").value === "yes",
      tddRationale: document.getElementById("plan-tdd-rationale").value,
      steps: values(stepsList, "step"),
      risks: values(risksList, "risk"),
      files: values(filesList, "file"),
      proposedCommands: [...commandsList.querySelectorAll("[data-row]")]
        .map((row) => ({
          pattern: row.querySelector("[data-pattern]").value.trim(),
          category: row.querySelector("[data-category]").value.trim(),
        }))
        .filter((c) => c.pattern),
      proposedDomains: [...domainsList.querySelectorAll("[data-row]")]
        .map((row) => ({ domain: row.querySelector("[data-domain]").value.trim() }))
        .filter((d) => d.domain),
      note: document.getElementById("plan-note").value,
    };
  }

  /** The approved-command/domain lists, which are separate from the plan text. */
  function collectApprovals() {
    return {
      commands: [...commandsList.querySelectorAll("[data-row]")]
        .map((row) => ({
          pattern: row.querySelector("[data-pattern]").value.trim(),
          category: row.querySelector("[data-category]").value.trim() || undefined,
          origin: "proposed",
        }))
        .filter((c) => c.pattern),
      domains: [...domainsList.querySelectorAll("[data-row]")]
        .map((row) => ({ domain: row.querySelector("[data-domain]").value.trim(), origin: "proposed" }))
        .filter((d) => d.domain),
    };
  }

  document.getElementById("save-plan").addEventListener("click", async (e) => {
    e.target.disabled = true;
    statusEl.textContent = "Saving…";
    try {
      const { changed } = await api.revisePlan(plan.id, collectPlanEdits());
      statusEl.textContent = changed ? "Saved as a new version." : "No changes to save.";
      if (changed) setTimeout(() => goToTask(plan.task_id, "plan"), 400);
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      e.target.disabled = false;
    }
  });

  document.getElementById("reject-plan").addEventListener("click", async () => {
    if (!confirm("Reject this plan? The task will be cancelled.")) return;
    await api.rejectPlan(plan.id);
    router();
  });

  document.getElementById("approve-plan").addEventListener("click", async (e) => {
    e.target.disabled = true;
    statusEl.textContent = "Approving…";
    try {
      // Edits ride along with the approval, so the server saves the new
      // version and approves that one — approving a stale version isn't
      // representable.
      await api.approvePlan(plan.id, { ...collectApprovals(), plan: collectPlanEdits() });
      router();
    } catch (err) {
      statusEl.textContent = err.message;
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
 * The agent's own task list (TaskCreate/TaskUpdate, or TodoWrite on older
 * builds) — what it's doing right now, in its words.
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

function renderRunView(run, detail, planSteps, streaming) {
  if (!run) return `<div class="card"><p class="muted">Waiting for the implementation run to start…</p></div>`;
  return `
    <div class="card">
      <div class="row between">
        <h2 style="margin:0">Implementation ${badge(run.status)}</h2>
        <span class="muted">run #${run.id} · ${esc(run.model)}</span>
      </div>
      <h3>Task list</h3>
      <div id="todo-area">${renderTodoList(detail?.todos, planSteps)}</div>
      <div id="approvals-area"></div>
      <div id="metrics-area"></div>
      <h3>${streaming ? "Live log" : "Log"}</h3>
      <div class="log" id="run-log">${streaming ? "" : renderStoredLog(detail?.log)}</div>
    </div>
  `;
}

/**
 * The run's log as it was stored. Only used when the stream isn't attached —
 * a live connection replays the same rows from seq 0, so rendering both
 * would double every line. Setup output is left out: it belongs to the setup
 * step, and an install log would bury the agent's own work here.
 */
function renderStoredLog(log) {
  if (!Array.isArray(log) || log.length === 0) {
    return `<div class="muted">No log entries were recorded for this run.</div>`;
  }
  const entries = log
    .filter((row) => row.kind !== "setup_output")
    .slice(-500)
    .map((row) => {
      let payload = {};
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        // A log row we can't parse is still worth showing as its kind alone.
      }
      return `<div class="entry"><span class="kind">[${esc(row.kind)}]</span> ${esc(summarize(row.kind, payload))}</div>`;
    });
  return entries.length ? entries.join("") : `<div class="muted">No log entries for this run.</div>`;
}

/** One log row as a single line of text — shared by the live stream and the stored log. */
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

// ---------- Approvals ----------

/**
 * The agent's multiple-choice question tool. It reaches the same approval path
 * as any other tool, but allow/deny is the wrong answer to it: approving
 * without picking an option leaves the agent to choose for itself, which is
 * exactly what it asked not to do. The options are rendered as a form and the
 * choice is sent back with the approval.
 */
function askedQuestions(approval) {
  if (approval.tool_name !== "AskUserQuestion") return null;
  try {
    const input = JSON.parse(approval.tool_input_json);
    return Array.isArray(input?.questions) && input.questions.length > 0 ? input.questions : null;
  } catch {
    return null;
  }
}

function approvalCard(a) {
  const questions = askedQuestions(a);
  return questions ? questionCard(a, questions) : toolApprovalCard(a);
}

function toolApprovalCard(a) {
  let input = {};
  try {
    input = JSON.parse(a.tool_input_json);
  } catch {
    // Falls through to the raw text below; a card is more useful than nothing.
  }
  return `
    <div class="approval-card" data-id="${a.id}">
      <div class="row between">
        <strong>${esc(a.tool_name)} needs your approval</strong>
      </div>
      <div class="command">${esc(input.command || a.tool_input_json)}</div>
      ${a.reason ? `<div class="reason">${esc(a.reason)}</div>` : ""}
      <div class="row" style="margin-top:0.5rem">
        <button class="primary" data-allow="${a.id}">Allow</button>
        <button class="danger" data-deny="${a.id}">Deny</button>
      </div>
    </div>
  `;
}

function questionCard(a, questions) {
  return `
    <div class="approval-card question-card" data-id="${a.id}" data-question-card="${a.id}">
      <div class="row between">
        <strong>The agent is asking${questions.length > 1 ? ` ${questions.length} questions` : ""}</strong>
      </div>
      ${questions.map((q, qi) => renderQuestion(a.id, q, qi)).join("")}
      <div class="row" style="margin-top:0.75rem">
        <button class="primary" data-send="${a.id}" disabled>
          Send answer${questions.length > 1 ? "s" : ""}
        </button>
        <button class="danger" data-deny="${a.id}">Dismiss</button>
        <span class="muted" data-answer-hint>Pick an option to answer.</span>
      </div>
    </div>
  `;
}

function renderQuestion(approvalId, q, qi) {
  const type = q.multiSelect ? "checkbox" : "radio";
  const name = `answer-${approvalId}-${qi}`;
  const options = Array.isArray(q.options) ? q.options : [];
  return `
    <div class="question">
      <div class="question-head">
        ${q.header ? `<span class="chip">${esc(q.header)}</span>` : ""}
        <span>${esc(q.question)}</span>
        ${q.multiSelect ? `<span class="muted">choose any</span>` : ""}
      </div>
      ${options.map((o) => `
        <label class="option">
          <input type="${type}" name="${name}" data-qi="${qi}" value="${esc(o.label)}" />
          <span class="option-text">
            <span class="option-label">${esc(o.label)}</span>
            ${o.description ? `<span class="option-desc">${esc(o.description)}</span>` : ""}
          </span>
        </label>
        ${o.preview ? `<pre class="option-preview">${esc(o.preview)}</pre>` : ""}
      `).join("")}
      <label class="option">
        <input type="${type}" name="${name}" data-qi="${qi}" value="" data-other-choice="${qi}" />
        <span class="option-text">
          <span class="option-label">Something else</span>
          <input class="option-other" type="text" data-other="${qi}"
                 placeholder="Answer in your own words" />
        </span>
      </label>
    </div>
  `;
}

/**
 * Collects one answer per question, keyed by the question's own text — the
 * shape the tool reads them back in. Multi-select answers are comma-separated,
 * and "Something else" contributes whatever the user typed.
 */
function collectAnswers(card, questions) {
  const answers = {};
  questions.forEach((q, qi) => {
    const chosen = [...card.querySelectorAll(`input[data-qi="${qi}"]:checked`)];
    const other = card.querySelector(`[data-other="${qi}"]`);
    const values = chosen
      .map((el) => (el.dataset.otherChoice === undefined ? el.value : (other?.value ?? "").trim()))
      .filter(Boolean);
    if (values.length > 0) answers[q.question] = values.join(", ");
  });
  return answers;
}

function wireQuestionCard(approval, onSubmit) {
  const questions = askedQuestions(approval);
  if (!questions) return;
  const card = document.querySelector(`[data-question-card="${approval.id}"]`);
  if (!card) return;
  const sendBtn = card.querySelector("[data-send]");
  const hint = card.querySelector("[data-answer-hint]");

  function sync() {
    const answers = collectAnswers(card, questions);
    const answered = Object.keys(answers).length;
    sendBtn.disabled = answered < questions.length;
    hint.textContent = sendBtn.disabled
      ? `${answered}/${questions.length} answered.`
      : "";
    return answers;
  }

  card.addEventListener("change", sync);
  // Typing in "Something else" is itself the choice: clicking a text field
  // inside a label doesn't select the label's radio, so it's done here.
  card.addEventListener("input", (e) => {
    const qi = e.target.dataset?.other;
    if (qi !== undefined) {
      const choice = card.querySelector(`[data-other-choice="${qi}"]`);
      if (choice) choice.checked = e.target.value.trim() !== "";
    }
    sync();
  });

  sendBtn.addEventListener("click", () => {
    const answers = sync();
    if (sendBtn.disabled) return;
    sendBtn.disabled = true;
    hint.textContent = "Sending…";
    onSubmit(answers);
  });
}

/**
 * Attaches the run's event stream to whichever panes the current step
 * rendered: the setup step has the install log, the implementation step has
 * the task list, approvals and the run log. Every pane is therefore
 * optional — the stream itself is the same either way.
 */
async function wireLiveRun(runId, ctx) {
  const logEl = document.getElementById("run-log");
  const approvalsEl = document.getElementById("approvals-area");
  const todoEl = document.getElementById("todo-area");
  const setupLogEl = document.getElementById("setup-log");
  const setupBadgeEl = document.getElementById("setup-badge");

  const planSteps = ctx.planSteps;
  let todos = ctx.detail?.todos ?? null;
  /** Guards the one automatic step advance below against the SSE replay. */
  let advanced = false;

  function appendLog(kind, payload) {
    if (!logEl) return;
    const div = document.createElement("div");
    div.className = "entry";
    div.innerHTML = `<span class="kind">[${esc(kind)}]</span> ${esc(summarize(kind, payload))}`;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
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
    if (!approvalsEl) return;
    const pending = await api.listApprovals(runId);
    approvalsEl.innerHTML = pending.map(approvalCard).join("");

    approvalsEl.querySelectorAll("[data-allow]").forEach((btn) =>
      btn.addEventListener("click", () => resolveApproval(btn.dataset.allow, "allow"))
    );
    approvalsEl.querySelectorAll("[data-deny]").forEach((btn) =>
      btn.addEventListener("click", () => resolveApproval(btn.dataset.deny, "deny"))
    );
    pending.forEach((a) => wireQuestionCard(a, (answers) => resolveApproval(a.id, "allow", answers)));
  }

  async function resolveApproval(id, decision, answers) {
    const note =
      decision === "deny" ? (prompt("Optional note for why you're denying this:") ?? "").trim() : "";
    // An empty note is no note: sending one would shadow the defaults the
    // server fills in (the answer summary, or "Denied by user").
    await api.resolveApproval(id, {
      decision,
      ...(note ? { note } : {}),
      ...(answers ? { answers } : {}),
    });
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
    // Setup finished while the user was watching it: follow the task on to
    // the implementation step, unless they pinned this one. Once per
    // connection — the replay that follows the re-render carries this same
    // event again.
    if (
      kind === "setup_status" &&
      payload.status === "succeeded" &&
      ctx.step === "setup" &&
      !advanced &&
      !pinnedStep()
    ) {
      advanced = true;
      setTimeout(() => router(), 400);
    }
  });
}

// ---------- Review changes & merge ----------

/**
 * The card is painted before the diff arrives: collecting it shells out to
 * git once per changed file, which is fast but not instant on a big branch,
 * and the rest of the task page shouldn't wait on it.
 */
function reviewCardShell(worktree) {
  return `
    <div class="card" id="review-card">
      <div class="row between">
        <h2 style="margin:0">Review changes</h2>
        <span class="muted">${esc(worktree.branch)}</span>
      </div>
      <p class="muted" id="review-loading">Collecting the diff…</p>
      <div id="review-body"></div>
    </div>
  `;
}

async function wireReview(worktree, task) {
  const bodyEl = document.getElementById("review-body");
  const loadingEl = document.getElementById("review-loading");
  if (!bodyEl) return;

  let changes;
  try {
    changes = await api.getWorktreeChanges(worktree.id);
  } catch (err) {
    loadingEl.className = "error-text";
    loadingEl.textContent = err.message;
    return;
  }
  loadingEl.remove();

  const { files, stat, merge, pullRequest } = changes;
  bodyEl.innerHTML = `
    ${renderLandPanel(worktree, merge, pullRequest, files, task)}
    ${files.length === 0
      ? `<p class="muted">No changes against <code>${esc(worktree.base_ref)}</code>.</p>`
      : `
        <div class="review-split">
          <nav class="file-list" id="file-tabs" aria-label="Changed files">
            <div class="file-list-head">
              <span>${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"}</span>
              <span><span class="diff-plus">+${stat.insertions}</span> <span class="diff-minus">−${stat.deletions}</span></span>
            </div>
            ${files.map((f, i) => fileTab(f, i)).join("")}
          </nav>
          <div class="diff-panel" id="diff-panel"></div>
        </div>
      `}
  `;

  if (files.length > 0) {
    const tabsEl = document.getElementById("file-tabs");
    const panelEl = document.getElementById("diff-panel");
    const select = (index) => {
      tabsEl.querySelectorAll("[data-file]").forEach((btn) =>
        btn.classList.toggle("active", Number(btn.dataset.file) === index)
      );
      panelEl.innerHTML = renderFileDiff(files[index]);
    };
    tabsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-file]");
      if (btn) select(Number(btn.dataset.file));
    });
    select(0);
  }

  wireLandPanel(worktree, merge, pullRequest);
}

const STATUS_MARK = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
  untracked: "U",
};

/** One row of the file sidebar: status letter, name over its directory, and the file's own counts. */
function fileTab(file, index) {
  const name = file.path.split("/").pop();
  const dir = file.path.slice(0, file.path.length - name.length);
  return `
    <button class="file-tab" data-file="${index}" title="${esc(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)}">
      <span class="file-status ${esc(file.status)}">${STATUS_MARK[file.status] || "?"}</span>
      <span class="file-text">
        <span class="file-name">${esc(name)}</span>
        ${dir ? `<span class="file-dir">${esc(dir)}</span>` : ""}
      </span>
      <span class="file-counts">${file.binary
        ? `<span class="muted">bin</span>`
        : `<span class="diff-plus">+${file.insertions}</span> <span class="diff-minus">−${file.deletions}</span>`}</span>
    </button>
  `;
}

/**
 * One file's patch, rendered the way git prints it — the +/- markers are kept
 * and the gutter carries the old/new line numbers read off each @@ hunk
 * header. Diff headers (index/---/+++/mode lines) are dropped: the tab
 * already says which file this is and what happened to it.
 */
function renderFileDiff(file) {
  const header = `
    <div class="diff-file-header">
      <code>${esc(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)}</code>
      <span class="muted">${esc(file.status.replace("_", " "))}</span>
    </div>
  `;
  if (file.binary) {
    return `${header}<p class="muted">Binary file — no textual diff.</p>`;
  }

  const skip = /^(diff --git |index |--- |\+\+\+ |new file |deleted file |old mode |new mode |similarity |dissimilarity |rename |copy |Binary files )/;
  const lines = file.patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  let oldNo = 0;
  let newNo = 0;
  const rows = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      rows.push(diffRow("hunk", "", "", line));
    } else if (skip.test(line)) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push(diffRow("add", "", newNo++, line));
    } else if (line.startsWith("-")) {
      rows.push(diffRow("del", oldNo++, "", line));
    } else if (line.startsWith("\\")) {
      rows.push(diffRow("meta", "", "", line)); // "\ No newline at end of file"
    } else {
      rows.push(diffRow("ctx", oldNo++, newNo++, line));
    }
  }

  if (rows.length === 0) {
    return `${header}<p class="muted">No textual changes (mode or metadata only).</p>`;
  }
  return `
    ${header}
    <div class="diff">${rows.join("")}</div>
    ${file.truncated ? `<p class="muted">Diff truncated — open the file in the worktree to see the rest.</p>` : ""}
  `;
}

function diffRow(kind, oldNo, newNo, text) {
  return `<div class="diff-line ${kind}"><span class="ln">${oldNo}</span><span class="ln">${newNo}</span><code>${esc(text)}</code></div>`;
}

/**
 * Two ways to land the branch, side by side: merge it into the main checkout,
 * or push it and open a pull request. They are mutually exclusive in practice
 * but not in principle (a merged branch can still have a PR open against a
 * remote), so both stay reachable and each explains its own blockers.
 *
 * The tab that opens is the one that can actually be used: a dirty main
 * checkout blocks the merge but not a push, and once a PR exists it's the
 * thing the user came back to look at.
 */
function renderLandPanel(worktree, merge, pullRequest, files, task) {
  const mergeSection = renderMergeSection(worktree, merge, files);
  const prSection = renderPrSection(worktree, pullRequest, merge, task);
  // A branch that already landed locally has nothing to propose, so a blocked
  // merge tab there is the end of the story rather than a reason to switch.
  const initial =
    worktree.pr_url ||
    (mergeSection.blocked && !prSection.blocked && !worktree.merged_at)
      ? "pr"
      : "merge";

  return `
    <div class="merge-bar">
      <div class="land-tabs" role="tablist">
        <button class="land-tab ${initial === "merge" ? "active" : ""}" data-land="merge" role="tab">
          Merge locally
        </button>
        <button class="land-tab ${initial === "pr" ? "active" : ""}" data-land="pr" role="tab">
          Open a pull request
        </button>
      </div>
      <div class="land-panel" data-land-panel="merge" ${initial === "merge" ? "" : "hidden"}>
        ${mergeSection.html}
      </div>
      <div class="land-panel" data-land-panel="pr" ${initial === "pr" ? "" : "hidden"}>
        ${prSection.html}
      </div>
    </div>
  `;
}

function wireLandPanel(worktree, merge, pullRequest) {
  const tabs = document.querySelectorAll(".land-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll("[data-land-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.landPanel !== tab.dataset.land;
      });
    });
  });
  wireMergeControls(worktree, merge);
  wirePrControls(worktree, pullRequest);
}

function renderMergeSection(worktree, merge, files) {
  const target = merge.targetBranch;
  const notes = [];
  let blocked = null;

  if (worktree.merged_at) {
    notes.push(`<div class="merge-note ok">Merged into <code>${esc(worktree.merge_target_branch || "?")}</code> at ${new Date(worktree.merged_at).toLocaleString()} (${esc((worktree.merge_commit || "").slice(0, 8))}).</div>`);
  }
  if (target === null) {
    blocked = "The main checkout is on a detached HEAD — check out a branch there first.";
  } else if (merge.alreadyMerged) {
    blocked = `<code>${esc(worktree.branch)}</code> is already part of <code>${esc(target)}</code> — nothing left to merge.`;
  } else if (!merge.repoClean) {
    blocked = `<code>${esc(target)}</code> has uncommitted changes. Commit or stash them first:<div class="merge-files">${merge.repoDirtyFiles.map((f) => esc(f)).join("<br>")}</div>`;
  } else if (files.length === 0) {
    blocked = "There is nothing to merge.";
  }

  if (merge.worktreeDirty) {
    notes.push(`<div class="merge-note">${merge.worktreeDirtyFiles.length} uncommitted file${merge.worktreeDirtyFiles.length === 1 ? "" : "s"} in the worktree will be committed on <code>${esc(worktree.branch)}</code> before merging.</div>`);
  }
  if (merge.targetAdvancedBy > 0) {
    notes.push(`<div class="merge-note">${esc(target || "the target branch")} has moved ${merge.targetAdvancedBy} commit${merge.targetAdvancedBy === 1 ? "" : "s"} since this worktree was created — the merge may conflict.</div>`);
  }

  const commits = merge.commits.length
    ? `<div class="muted">${merge.commits.length} commit${merge.commits.length === 1 ? "" : "s"} on this branch: ${esc(merge.commits.map((c) => c.subject).slice(0, 3).join(" · "))}${merge.commits.length > 3 ? " …" : ""}</div>`
    : `<div class="muted">No commits on this branch yet.</div>`;

  return {
    blocked,
    html: `
      <div class="row between">
        <div>
          <strong>Merge <code>${esc(worktree.branch)}</code> into <code>${esc(target || "—")}</code></strong>
          ${commits}
        </div>
        <div class="row">
          <select id="merge-mode" class="merge-mode">
            <option value="merge">Merge commit</option>
            <option value="squash">Squash into one commit</option>
          </select>
          <button class="primary" id="do-merge" ${blocked ? "disabled" : ""}>
            Merge into ${esc(target || "—")}
          </button>
        </div>
      </div>
      ${blocked ? `<div class="merge-note blocked">${blocked}</div>` : ""}
      ${notes.join("")}
      <label for="merge-message">Commit message <span class="muted">(optional)</span></label>
      <input id="merge-message" placeholder="Defaults to the task title" />
      <label class="inline"><input type="checkbox" id="merge-remove" /> Remove the worktree after merging</label>
      <div id="merge-status" class="muted"></div>
    `,
  };
}

/**
 * The pull-request half of the panel. Everything it needs to know came with
 * the diff (`pullRequest` in the changes payload) and is local git state, so
 * nothing here has hit the network yet — the first call to GitHub happens when
 * the user presses the button.
 */
function renderPrSection(worktree, pr, merge, task) {
  const notes = [];
  let blocked = null;

  if (worktree.pr_url) {
    notes.push(`<div class="merge-note ok">Pull request <a href="${esc(worktree.pr_url)}" target="_blank" rel="noreferrer">${esc(worktree.pr_number ? `#${worktree.pr_number}` : "open")}</a> against <code>${esc(worktree.pr_base_branch || "?")}</code>, opened ${new Date(worktree.pr_opened_at).toLocaleString()}. Opening again pushes the branch's new commits to it.</div>`);
  }

  if (!pr.ghAvailable) {
    blocked = "The GitHub CLI (<code>gh</code>) isn't on the server's PATH — autocode uses it so it never has to hold a token of its own.";
  } else if (!pr.ghAuthenticated) {
    blocked = "The GitHub CLI has no credentials. Run <code>gh auth login</code> (or set <code>GH_TOKEN</code>) as the user running autocode.";
  } else if (!pr.remote) {
    blocked = `<code>${esc(worktree.repo_path)}</code> has no git remote to push to.`;
  } else if (pr.baseCandidates.length === 0) {
    blocked = `No branches on <code>${esc(pr.remote)}</code> to target — push the base branch first.`;
  } else if (pr.commitCount === 0 && !merge.worktreeDirty) {
    blocked = `<code>${esc(worktree.branch)}</code> has no commits of its own — there is nothing to propose.`;
  }

  if (merge.worktreeDirty) {
    notes.push(`<div class="merge-note">${merge.worktreeDirtyFiles.length} uncommitted file${merge.worktreeDirtyFiles.length === 1 ? "" : "s"} in the worktree will be committed on <code>${esc(worktree.branch)}</code> before the push.</div>`);
  }
  if (pr.pushed && !pr.pushUpToDate) {
    notes.push(`<div class="merge-note"><code>${esc(pr.remote)}/${esc(worktree.branch)}</code> already exists and is behind the worktree — the push will add the newer commits.</div>`);
  }
  if (!blocked && pr.baseCandidates.length > 0) {
    // The base field is a datalist, which looks like a plain text box until
    // you type — worth saying that it searches, and that it isn't limited to
    // what's listed.
    notes.push(`<div class="merge-note">Type in the base field to search ${pr.baseCandidates.length} branch${pr.baseCandidates.length === 1 ? "" : "es"} on <code>${esc(pr.remote)}</code>${pr.baseCandidatesTruncated ? " (the busiest ones)" : ""} — or type any branch name the remote has.</div>`);
  }

  const commits = pr.commitCount
    ? `<div class="muted">${pr.commitCount} commit${pr.commitCount === 1 ? "" : "s"} to push${pr.remote ? ` to <code>${esc(pr.remoteUrl || pr.remote)}</code>` : ""}.</div>`
    : `<div class="muted">Nothing committed on this branch yet.</div>`;

  return {
    blocked,
    html: `
      <div class="row between">
        <div>
          <strong>Push <code>${esc(worktree.branch)}</code> and open a pull request</strong>
          ${commits}
        </div>
        <div class="row">
          <label class="base-field">
            <span class="muted">Base</span>
            <input id="pr-base" class="base-input" list="pr-base-options" type="text"
                   value="${esc(pr.defaultBase || "")}"
                   placeholder="Branch to merge into"
                   autocomplete="off" spellcheck="false" ${blocked ? "disabled" : ""} />
          </label>
          <datalist id="pr-base-options">
            ${pr.baseCandidates.map((b) => `<option value="${esc(b)}"></option>`).join("")}
          </datalist>
          <button class="primary" id="do-pr" ${blocked ? "disabled" : ""}>
            ${worktree.pr_url ? "Push to the pull request" : "Open pull request"}
          </button>
        </div>
      </div>
      ${blocked ? `<div class="merge-note blocked">${blocked}</div>` : ""}
      ${notes.join("")}
      <label for="pr-title">Title <span class="muted">(optional)</span></label>
      <input id="pr-title" placeholder="${esc(task?.title || "Defaults to the task title")}" />
      <label for="pr-body">Description <span class="muted">(optional)</span></label>
      <textarea id="pr-body" placeholder="Defaults to the task description."></textarea>
      <label class="inline"><input type="checkbox" id="pr-draft" /> Open as a draft</label>
      <div id="pr-status" class="muted"></div>
    `,
  };
}

function wirePrControls(worktree, pr) {
  const btn = document.getElementById("do-pr");
  const statusEl = document.getElementById("pr-status");
  if (!btn || btn.disabled) return;

  btn.addEventListener("click", async () => {
    const base = document.getElementById("pr-base").value.trim();
    if (!base) {
      statusEl.className = "error-text";
      statusEl.textContent = "Name the branch to open the pull request against.";
      return;
    }
    const title = document.getElementById("pr-title").value.trim();
    const body = document.getElementById("pr-body").value.trim();
    const draft = document.getElementById("pr-draft").checked;
    // Pushing publishes the branch to a remote other people can see, so it
    // gets the same confirmation the merge does.
    if (!confirm(`Push ${worktree.branch} to ${pr.remote} and open a pull request against ${base}?`)) {
      return;
    }
    btn.disabled = true;
    statusEl.className = "muted";
    statusEl.textContent = "Pushing and opening the pull request…";
    try {
      const result = await api.openPullRequest(worktree.id, {
        base,
        draft,
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
      });
      statusEl.className = "muted";
      statusEl.innerHTML = `${result.alreadyExisted ? "Pushed to the existing pull request" : "Opened"} <a href="${esc(result.url)}" target="_blank" rel="noreferrer">${esc(result.number ? `#${result.number}` : result.url)}</a> against ${esc(result.base)}.`;
      setTimeout(() => router(), 1200);
    } catch (err) {
      statusEl.className = "error-text";
      const output = err.data?.output;
      statusEl.innerHTML =
        esc(err.message) + (output ? `<div class="merge-files">${esc(output)}</div>` : "");
      btn.disabled = false;
    }
  });
}

function wireMergeControls(worktree, merge) {
  const btn = document.getElementById("do-merge");
  const statusEl = document.getElementById("merge-status");
  if (!btn || btn.disabled) return;

  btn.addEventListener("click", async () => {
    const mode = document.getElementById("merge-mode").value;
    const removeWorktree = document.getElementById("merge-remove").checked;
    const message = document.getElementById("merge-message").value.trim();
    const target = merge.targetBranch;
    if (!confirm(`${mode === "squash" ? "Squash" : "Merge"} ${worktree.branch} into ${target} in ${worktree.repo_path}?`)) {
      return;
    }
    btn.disabled = true;
    statusEl.className = "muted";
    statusEl.textContent = "Merging…";
    try {
      const result = await api.mergeWorktree(worktree.id, {
        mode,
        removeWorktree,
        ...(message ? { message } : {}),
      });
      statusEl.className = "muted";
      statusEl.textContent = result.alreadyUpToDate
        ? `Already up to date with ${result.targetBranch}.`
        : `Merged into ${result.targetBranch} at ${result.headSha.slice(0, 8)}.`;
      setTimeout(() => router(), 800);
    } catch (err) {
      statusEl.className = "error-text";
      const conflicts = err.data?.conflicts;
      statusEl.innerHTML =
        esc(err.message) +
        (conflicts?.length ? `<div class="merge-files">${conflicts.map((f) => esc(f)).join("<br>")}</div>` : "");
      btn.disabled = false;
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
