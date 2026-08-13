import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, loadConfig, loadProjectSeeds, resolveBindHost } from "../config.ts";
import { openDb, type Db } from "../db/index.ts";
import type { PlanRow } from "../types.ts";
import { upsertProjectSeeds, listProjects, createProject, getProject } from "../db/repo/projects.ts";
import { createTask, getTask, listTasks, setTaskStatus } from "../db/repo/tasks.ts";
import { listRuns, getRun, listRunsByStatus, setRunStatus, createRun } from "../db/repo/runs.ts";
import {
  getPlan,
  getPlanForTask,
  setPlanStatus,
  addApprovedCommandRules,
  addApprovedNetworkDomains,
  createPlanRevision,
  listPlanVersions,
} from "../db/repo/plans.ts";
import { PlanEditSchema, applyPlanEdits } from "./plan-edit.ts";
import {
  listWorktrees,
  getWorktree,
  setWorktreeStatus,
  createWorktree,
  countWorktreesForTask,
  markWorktreeSetupFinished,
  listWorktreesBySetupStatus,
} from "../db/repo/worktrees.ts";
import { listPendingApprovals } from "../db/repo/approvals.ts";
import { listBackgroundTasks } from "../db/repo/background.ts";
import { getMetricsForRun, listMetrics } from "../db/repo/metrics.ts";
import { listRunLog, appendRunLog } from "../db/repo/log.ts";
import { getRunTodos } from "../db/repo/todos.ts";
import { runPlanner } from "../agent/planner.ts";
import { createWorktreeOnDisk, removeWorktreeFromDisk, getDiffStat } from "../worktree/manager.ts";
import { runImplementationPipeline, type RunAgent } from "./implement.ts";
import { registerAuth } from "./auth.ts";
import { countUsers } from "../db/repo/users.ts";
import { sseHandler } from "../notify/sse.ts";
import { createFanout, registerSideChannel } from "../notify/index.ts";
import { sendDesktopNotification } from "../notify/desktop.ts";
import { configureWebPush, sendWebPush } from "../notify/webpush.ts";
import { upsertPushSubscription, removePushSubscription } from "../db/repo/push.ts";
import {
  reconcileOrphanedApprovalsOnBoot,
  createLiveCanUseTool,
  resolvePendingApproval,
} from "./approvals.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

export interface BuildServerOptions {
  /** Defaults to config/autocode.json; overridden by tests to get an isolated dataDir and silent notifications. */
  configPath?: string;
  projectsPath?: string;
  /**
   * Test seam: replaces the real implementation agent, so the worktree
   * setup half of the pipeline can be exercised end to end without a live
   * model call. Production always leaves this unset.
   */
  runAgent?: RunAgent;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const config = loadConfig(options.configPath ?? path.join(REPO_ROOT, "config", "autocode.json"));
  const db = openDb(config.dbPath);

  // Boot reconciliation: anything left "pending"/"running" belongs to a
  // process lifetime that's gone. Also unstick the parent task so the UI
  // offers a retry instead of leaving it permanently stuck on
  // "planning"/"implementing" with no run left to ever finish it — this
  // was caught live during Gate 4 dry-runs (the dev server got killed by
  // its own timeout wrapper mid-implementation, exactly the crash this
  // reconciliation exists for).
  const expiredApprovals = reconcileOrphanedApprovalsOnBoot(db);
  for (const run of listRunsByStatus(db, "running")) {
    setRunStatus(db, run.id, "interrupted", {
      error: "Server restarted while this run was in progress.",
    });
    const task = getTask(db, run.task_id);
    if (!task) continue;
    if (
      run.phase === "implementation" &&
      (task.status === "implementing" || task.status === "setting_up")
    ) {
      setTaskStatus(db, task.id, "approved"); // plan is still approved — retry via /implement
    } else if (run.phase === "planning" && task.status === "planning") {
      setTaskStatus(db, task.id, "failed"); // no retry-planning endpoint yet; surface as failed
    }
  }
  // Same reasoning one level down: a setup command still marked 'running'
  // belongs to a dead process. Its worktree may be half-installed, so it's
  // recorded as failed rather than quietly presented as ready — a retry
  // creates a fresh worktree and re-runs setup from scratch.
  for (const wt of listWorktreesBySetupStatus(db, "running")) {
    markWorktreeSetupFinished(db, wt.id, {
      status: "failed",
      exitCode: null,
      output: `${wt.setup_output ?? ""}\n[autocode] Server restarted while the setup command was running.`,
    });
  }

  const seedsPath = options.projectsPath ?? path.join(REPO_ROOT, "config", "projects.json");
  try {
    upsertProjectSeeds(db, loadProjectSeeds(seedsPath));
  } catch {
    // No seed file, or it's empty — projects can still be registered via the API.
  }

  const fanout = createFanout((runId, kind, payload) => appendRunLog(db, runId, kind, payload));

  if (config.notify.desktop) {
    registerSideChannel(sendDesktopNotification);
  }
  const vapidKeys = config.notify.webPush ? configureWebPush(db, "autocode@localhost") : null;
  if (config.notify.webPush) {
    registerSideChannel((event) => {
      sendWebPush(db, event).catch(() => {
        // Individual subscription failures are handled inside sendWebPush
        // (recordPushFailure); this only guards the fire-and-forget call
        // itself never becoming an unhandled rejection.
      });
    });
  }

  const app = Fastify({ logger: true, trustProxy: config.trustProxy });

  // Must come first: registerAuth installs the onRequest guard, and a hook
  // added after a route is registered doesn't run for it. Everything below
  // this line — API, static files, SSE — is behind a session.
  await registerAuth({ app, db, config });

  if (countUsers(db) === 0) {
    app.log.warn(
      "No user accounts exist — every request will bounce to the login page. Create one with: pnpm create-user <username>"
    );
  }

  await app.register(fastifyStatic, {
    root: path.join(REPO_ROOT, "public"),
    prefix: "/",
  });

  // ---- Projects ----
  app.get("/api/projects", async () => listProjects(db));
  app.post<{
    Body: {
      name: string;
      repoPath: string;
      defaultBaseRef?: string;
      allowedNetworkDomains?: string[];
      setupCommand?: string | null;
    };
  }>(
    "/api/projects",
    async (req, reply) => {
      const p = createProject(db, {
        name: req.body.name,
        repoPath: expandHome(req.body.repoPath),
        defaultBaseRef: req.body.defaultBaseRef,
        allowedNetworkDomains: req.body.allowedNetworkDomains,
        setupCommand: req.body.setupCommand?.trim() || null,
      });
      reply.code(201);
      return p;
    }
  );

  // ---- Tasks ----
  app.get("/api/tasks", async () => listTasks(db));
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const task = getTask(db, Number(req.params.id));
    if (!task) return reply.code(404).send({ error: "task not found" });
    return {
      task,
      runs: listRuns(db, task.id),
      plan: getPlanForTask(db, task.id),
    };
  });

  app.post<{ Body: { projectId: number; title: string; description: string } }>(
    "/api/tasks",
    async (req, reply) => {
      const project = getProject(db, req.body.projectId);
      if (!project) return reply.code(400).send({ error: "unknown project" });

      const task = createTask(db, {
        projectId: project.id,
        title: req.body.title,
        description: req.body.description,
      });
      setTaskStatus(db, task.id, "planning");

      // Fire-and-forget: planning is a real agent call that can take
      // minutes. The client watches progress over SSE / polls the task.
      runPlanner({
        db,
        task,
        project,
        model: config.models.planner,
        maxTurns: config.budgets.plannerMaxTurns,
        maxBudgetUsd: config.budgets.plannerMaxBudgetUsd,
      })
        .then((outcome) => {
          if (outcome.ok && outcome.plan) {
            setTaskStatus(db, task.id, "awaiting_approval");
            fanout({
              kind: "plan_ready",
              runId: outcome.plan.run_id,
              title: "Plan ready for review",
              body: outcome.plan.summary,
            });
          } else {
            app.log.error({ taskId: task.id, error: outcome.errorSummary }, "planner run failed");
            setTaskStatus(db, task.id, "failed");
          }
        })
        .catch((err) => {
          app.log.error(err, "planner run threw");
          setTaskStatus(db, task.id, "failed");
        });

      reply.code(201);
      return { task };
    }
  );

  // ---- Plans ----
  app.get<{ Params: { id: string } }>("/api/plans/:id", async (req, reply) => {
    const plan = getPlan(db, Number(req.params.id));
    if (!plan) return reply.code(404).send({ error: "plan not found" });
    return plan;
  });

  /**
   * Edit a generated plan instead of throwing it away and re-planning.
   * Writes a new version and supersedes the old one; the response is the
   * new plan, which is what the client then approves.
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/plans/:id/revise",
    async (req, reply) => {
      const plan = getPlan(db, Number(req.params.id));
      if (!plan) return reply.code(404).send({ error: "plan not found" });

      const guard = planIsEditable(db, plan);
      if (!guard.ok) return reply.code(409).send({ error: guard.error });

      const parsed = PlanEditSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: `invalid plan edit: ${parsed.error.message}` });
      }

      const edited = applyPlanEdits(plan, parsed.data);
      if (!edited.ok) return reply.code(400).send({ error: edited.error });
      if (!edited.changed) return { plan, changed: false };

      const revision = createPlanRevision(db, plan, edited.value);
      // An edit after approval puts the task back in front of the human —
      // what they approved is not what would now run.
      if (plan.status === "approved") {
        setTaskStatus(db, plan.task_id, "awaiting_approval");
      }
      app.log.info(
        { taskId: plan.task_id, from: plan.id, to: revision.id, version: revision.version },
        "plan revised"
      );
      reply.code(201);
      return { plan: revision, changed: true };
    }
  );

  app.get<{ Params: { id: string } }>("/api/tasks/:id/plans", async (req) =>
    listPlanVersions(db, Number(req.params.id))
  );

  app.post<{
    Params: { id: string };
    Body: {
      commands: { pattern: string; category?: string; note?: string; origin: "proposed" | "user_added" }[];
      domains: { domain: string; note?: string; origin: "proposed" | "user_added" }[];
      note?: string;
      /**
       * Optional edits to apply first. Lets the UI save-and-approve in one
       * click, so an edited plan can never be approved as its pre-edit
       * version through a lost race between two requests.
       */
      plan?: unknown;
    };
  }>("/api/plans/:id/approve", async (req, reply) => {
    let plan = getPlan(db, Number(req.params.id));
    if (!plan) return reply.code(404).send({ error: "plan not found" });

    if (req.body.plan !== undefined) {
      const guard = planIsEditable(db, plan);
      if (!guard.ok) return reply.code(409).send({ error: guard.error });

      const parsed = PlanEditSchema.safeParse(req.body.plan);
      if (!parsed.success) {
        return reply.code(400).send({ error: `invalid plan edit: ${parsed.error.message}` });
      }
      const edited = applyPlanEdits(plan, parsed.data);
      if (!edited.ok) return reply.code(400).send({ error: edited.error });
      if (edited.changed) plan = createPlanRevision(db, plan, edited.value);
    }

    addApprovedCommandRules(db, plan.id, req.body.commands);
    addApprovedNetworkDomains(db, plan.id, req.body.domains);
    setPlanStatus(db, plan.id, "approved", req.body.note);
    setTaskStatus(db, plan.task_id, "approved");

    reply.code(200);
    return { ok: true, planId: plan.id };
  });

  app.post<{ Params: { id: string } }>("/api/plans/:id/reject", async (req, reply) => {
    const plan = getPlan(db, Number(req.params.id));
    if (!plan) return reply.code(404).send({ error: "plan not found" });
    setPlanStatus(db, plan.id, "rejected");
    setTaskStatus(db, plan.task_id, "cancelled");
    return { ok: true };
  });

  // ---- Implement (worktree + implementer) ----
  app.post<{ Params: { id: string } }>("/api/plans/:id/implement", async (req, reply) => {
    const plan = getPlan(db, Number(req.params.id));
    if (!plan) return reply.code(404).send({ error: "plan not found" });
    if (plan.status !== "approved") {
      return reply.code(400).send({ error: "plan is not approved" });
    }
    const task = getTask(db, plan.task_id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const project = getProject(db, task.project_id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const attempt = countWorktreesForTask(db, task.id) + 1;
    const wt = createWorktreeOnDisk({
      repoPath: project.repo_path,
      taskId: task.id,
      taskTitle: task.title,
      baseRef: project.default_base_ref,
      worktreeRoot: config.worktreeRoot,
      attempt,
    });
    const worktree = createWorktree(db, {
      taskId: task.id,
      repoPath: project.repo_path,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseRef: project.default_base_ref,
      baseSha: wt.baseSha,
      scratchPath: wt.scratchPath,
    });

    // Created up front (rather than inside runImplementer) for two reasons:
    // canUseTool needs the run id for approval routing without the mutable-ref
    // dance this used to require, and the setup command's output can stream
    // into the same run_log/SSE channel the user is already watching — from
    // the user's point of view "installing dependencies" is the first thing
    // this run does.
    const run = createRun(db, {
      taskId: task.id,
      phase: "implementation",
      model: config.models.implementer,
      cwd: worktree.worktree_path,
      worktreeId: worktree.id,
    });

    const canUseTool = createLiveCanUseTool({
      db,
      runId: run.id,
      pendingTimeoutMs: config.approvals.pendingTimeoutMs,
      fanout,
      // Same NO_PROXY narrowing the filter hook applies to auto-allowed
      // commands: a command the human approves has to be able to reach the
      // project's dev services too.
      localServiceHosts: JSON.parse(project.local_service_hosts || "[]") as string[],
    });

    // A project's own command wins; config.setup.defaultCommand is the
    // fallback for projects that don't set one. Null in both means no setup.
    const setupCommand = project.setup_command ?? config.setup.defaultCommand;

    setTaskStatus(db, task.id, setupCommand ? "setting_up" : "implementing");

    // Fire-and-forget, like planning: setup (a cold `pnpm install` can take
    // minutes) plus the implementation run both outlive this request.
    runImplementationPipeline({
      db,
      task,
      project,
      plan,
      worktree,
      run,
      setupCommand,
      setupTimeoutMs: config.setup.timeoutMs,
      model: config.models.implementer,
      maxTurns: config.budgets.implementerMaxTurns,
      maxBudgetUsd: config.budgets.implementerMaxBudgetUsd,
      canUseTool,
      fanout,
      logError: (context, message) => app.log.error(context, message),
      ...(options.runAgent !== undefined ? { runAgent: options.runAgent } : {}),
    }).catch((err) => {
      app.log.error(err, "implementation pipeline threw");
      setRunStatus(db, run.id, "failed", { error: (err as Error).message });
      setTaskStatus(db, task.id, "failed");
    });

    reply.code(202);
    return { worktree, run };
  });

  // ---- Runs ----
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = getRun(db, Number(req.params.id));
    if (!run) return reply.code(404).send({ error: "run not found" });
    return {
      run,
      metrics: getMetricsForRun(db, run.id),
      backgroundTasks: listBackgroundTasks(db, run.id),
      log: listRunLog(db, run.id),
      // The agent's live task list and the worktree's setup state — both
      // rendered above the log on the task page, and both needed on first
      // paint (SSE only carries what happens *after* the client connects).
      todos: getRunTodos(db, run.id),
      worktree: run.worktree_id === null ? null : getWorktree(db, run.worktree_id) ?? null,
    };
  });
  app.get("/api/metrics", async () => listMetrics(db));

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/runs/:id/events",
    (req, reply) => {
      const runId = Number(req.params.id);
      const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? req.query.since;
      reply.hijack();
      sseHandler(db, runId, reply.raw, lastEventId);
    }
  );

  // ---- Worktrees ----
  app.get("/api/worktrees", async () => listWorktrees(db));
  app.get<{ Params: { id: string } }>("/api/worktrees/:id/diff", async (req, reply) => {
    const wt = getWorktree(db, Number(req.params.id));
    if (!wt) return reply.code(404).send({ error: "worktree not found" });
    return getDiffStat(wt.worktree_path, wt.base_sha);
  });
  app.post<{ Params: { id: string } }>("/api/worktrees/:id/discard", async (req, reply) => {
    const wt = getWorktree(db, Number(req.params.id));
    if (!wt) return reply.code(404).send({ error: "worktree not found" });
    removeWorktreeFromDisk({
      repoPath: wt.repo_path,
      worktreePath: wt.worktree_path,
      scratchPath: wt.scratch_path,
      branch: wt.branch,
      deleteBranch: true,
      force: true,
    });
    setWorktreeStatus(db, wt.id, "removed");
    return { ok: true };
  });

  // ---- Approvals ----
  app.get("/api/approvals", async (req) => {
    const runId = (req.query as { runId?: string }).runId;
    return listPendingApprovals(db, runId ? Number(runId) : undefined);
  });
  app.post<{
    Params: { id: string };
    Body: { decision: "allow" | "deny"; rememberScope?: "once" | "run" | "plan"; note?: string };
  }>("/api/approvals/:id/resolve", async (req, reply) => {
    const ok = resolvePendingApproval(Number(req.params.id), {
      decision: req.body.decision,
      rememberScope: req.body.rememberScope ?? "once",
      note: req.body.note,
    });
    if (!ok) return reply.code(404).send({ error: "no pending approval with that id (already resolved or expired)" });
    return { ok: true };
  });

  // ---- Web Push ----
  app.get("/api/push/vapid-public-key", async (_req, reply) => {
    if (!vapidKeys) return reply.code(404).send({ error: "web push is disabled" });
    return { publicKey: vapidKeys.publicKey };
  });
  app.post<{
    Body: { endpoint: string; keys: { p256dh: string; auth: string } };
  }>("/api/push/subscribe", async (req, reply) => {
    upsertPushSubscription(db, {
      endpoint: req.body.endpoint,
      p256dh: req.body.keys.p256dh,
      auth: req.body.keys.auth,
      userAgent: req.headers["user-agent"] ?? null,
    });
    reply.code(201);
    return { ok: true };
  });
  app.post<{ Body: { endpoint: string } }>("/api/push/unsubscribe", async (req) => {
    removePushSubscription(db, req.body.endpoint);
    return { ok: true };
  });

  return { app, db, config, expiredApprovals };
}

/**
 * A plan can be edited while it's still the live one and nothing has been
 * built from it. Once an implementation run exists, the worktree and the
 * agent's context were derived from the approved text, so editing it would
 * describe work that isn't what's actually happening — retry the task
 * instead.
 */
function planIsEditable(db: Db, plan: PlanRow): { ok: true } | { ok: false; error: string } {
  if (plan.status === "superseded") {
    return { ok: false, error: "this plan version was already replaced by a newer one" };
  }
  if (plan.status === "rejected") {
    return { ok: false, error: "this plan was rejected" };
  }
  if (listRuns(db, plan.task_id).some((r) => r.phase === "implementation")) {
    return { ok: false, error: "implementation has already started for this task" };
  }
  return { ok: true };
}

export async function startServer() {
  const { app, config } = await buildServer();
  // `iface:<name>` binds to a VPN interface's current address — see
  // resolveBindHost. Resolved here rather than at config load so that
  // database-only tools keep working when the VPN is down.
  const host = resolveBindHost(config.host);
  await app.listen({ port: config.port, host });
  app.log.info(
    { host, spec: config.host, port: config.port },
    "autocode listening — reachable only on this address"
  );
  return app;
}

// Auto-start only when this file is the actual process entrypoint (`pnpm
// dev` / `node src/server/index.ts`), not when buildServer/startServer are
// imported elsewhere (e.g. the spike scripts under scripts/).
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
