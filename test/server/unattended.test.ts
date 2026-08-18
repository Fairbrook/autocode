import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server/index.ts";
import type { Db } from "../../src/db/index.ts";
import { createProject } from "../../src/db/repo/projects.ts";
import { createTask } from "../../src/db/repo/tasks.ts";
import { createRun, getRun, setRunUnattended } from "../../src/db/repo/runs.ts";
import { getApprovalRequest, listPendingApprovals } from "../../src/db/repo/approvals.ts";
import { listRunLog } from "../../src/db/repo/log.ts";
import {
  createLiveCanUseTool,
  resolvePendingApproval,
  UNATTENDED_NOTE,
} from "../../src/server/approvals.ts";
import { loginAs } from "../helpers/auth.ts";
import { writeTestConfig } from "../helpers/server.ts";

/**
 * Unattended mode: the user has said, for this run, that whatever the agent
 * asks for is allowed. It has to answer calls that arrive after the switch is
 * flipped *and* the one the agent is already parked on, and it must not widen
 * anything else — a denied command is still denied by the filter engine, which
 * never reaches this path at all.
 */

let base: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let db: Db;
let auth: Record<string, string>;
let runId: number;
let notifications: string[];
let canUseTool: ReturnType<typeof createLiveCanUseTool>;

function ask(toolName: string, toolInput: Record<string, unknown>) {
  return canUseTool(toolName, toolInput, {
    signal: new AbortController().signal,
    toolUseID: "toolu_1",
    requestId: "req_1",
  });
}

async function waitForPending(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const [pending] = listPendingApprovals(db, runId);
    if (pending) return pending.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the approval request never appeared");
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-unattended-test-"));
  const repoPath = path.join(base, "repo");
  mkdirSync(repoPath, { recursive: true });

  const { configPath, projectsPath } = writeTestConfig(base);
  server = await buildServer({ configPath, projectsPath });
  db = server.db;
  auth = (await loginAs(server.app, db)).headers;

  const project = createProject(db, { name: "demo", repoPath, setupCommand: null });
  const task = createTask(db, { projectId: project.id, title: "t", description: "d" });
  const run = createRun(db, {
    taskId: task.id,
    phase: "implementation",
    model: "sonnet",
    cwd: repoPath,
  });
  runId = run.id;

  notifications = [];
  canUseTool = createLiveCanUseTool({
    db,
    runId,
    pendingTimeoutMs: 60_000,
    fanout: (event) => notifications.push(event.kind),
  });
});

afterEach(async () => {
  await server.app.close();
  rmSync(base, { recursive: true, force: true });
});

describe("unattended runs", () => {
  it("starts attended", () => {
    expect(getRun(db, runId)?.unattended).toBe(0);
  });

  it("allows a tool call without asking, and records who allowed it", async () => {
    setRunUnattended(db, runId, true);

    // No waiting, no parked promise: this resolves on its own.
    const result = (await ask("Bash", { command: "rm -rf node_modules" })) as {
      behavior: string;
    };
    expect(result.behavior).toBe("allow");

    // The request is still written down — the point is that nobody was asked,
    // not that nothing happened.
    const [row] = listRunLog(db, runId)
      .filter((r) => r.kind === "approval_request")
      .map((r) => JSON.parse(r.payload_json) as { id: number });
    const approval = getApprovalRequest(db, row!.id)!;
    expect(approval.status).toBe("allowed");
    expect(approval.resolution_note).toBe(UNATTENDED_NOTE);
    expect(listPendingApprovals(db, runId)).toHaveLength(0);

    // And no notification went out: not being interrupted is the whole feature.
    expect(notifications).toEqual([]);
  });

  it("lets the agent answer its own question", async () => {
    setRunUnattended(db, runId, true);
    const input = {
      questions: [
        {
          question: "Delete .env.local?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };

    const result = (await ask("AskUserQuestion", input)) as {
      behavior: string;
      updatedInput?: unknown;
    };
    expect(result.behavior).toBe("allow");
    // No answers attached is the SDK's "you decide" — the agent picks and
    // carries on rather than blocking on someone who has stepped away.
    expect(result.updatedInput).toBeUndefined();
  });

  it("releases the call the agent is already parked on when the switch is flipped", async () => {
    const decision = ask("Bash", { command: "pnpm test" });
    const approvalId = await waitForPending();

    const res = await server.app.inject({
      method: "POST",
      url: `/api/runs/${runId}/unattended`,
      headers: auth,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ unattended: true, released: 1 });

    const result = (await decision) as { behavior: string };
    expect(result.behavior).toBe("allow");
    expect(getApprovalRequest(db, approvalId)?.resolution_note).toBe(UNATTENDED_NOTE);
    expect(getRun(db, runId)?.unattended).toBe(1);

    // The flip is in the run log, so the transcript explains why every
    // approval after this point resolved itself.
    const logged = listRunLog(db, runId).filter((r) => r.kind === "unattended");
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload_json)).toEqual({ enabled: true, released: 1 });
  });

  it("hands control back when it is turned off", async () => {
    setRunUnattended(db, runId, true);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/runs/${runId}/unattended`,
      headers: auth,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ unattended: false, released: 0 });
    expect(getRun(db, runId)?.unattended).toBe(0);

    // The next call parks for a human again instead of resolving itself.
    const decision = ask("Bash", { command: "pnpm test" });
    const approvalId = await waitForPending();
    expect(getApprovalRequest(db, approvalId)?.status).toBe("pending");
    expect(notifications).toEqual(["approval_needed"]);

    resolvePendingApproval(approvalId, { decision: "deny", rememberScope: "once" });
    expect(((await decision) as { behavior: string }).behavior).toBe("deny");
  });

  it("404s for a run that doesn't exist", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/runs/9999/unattended",
      headers: auth,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("needs a session like every other write", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/runs/${runId}/unattended`,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
