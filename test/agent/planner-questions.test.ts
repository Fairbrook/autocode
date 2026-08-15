import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

/**
 * The planning agent runs read-only and fire-and-forget, but it can still stop
 * to ask the user a question — and a question is only answerable if it is
 * filed against the planning run the task page is watching.
 *
 * runSession is stubbed: what matters here is what the planner hands the SDK,
 * not what the model does with it.
 */
const { runSessionMock } = vi.hoisted(() => ({ runSessionMock: vi.fn() }));
vi.mock("../../src/agent/session-runner.ts", () => ({
  runSession: (input: unknown) => runSessionMock(input),
}));

const { openDb } = await import("../../src/db/index.ts");
const { createProject } = await import("../../src/db/repo/projects.ts");
const { createTask } = await import("../../src/db/repo/tasks.ts");
const { listRuns } = await import("../../src/db/repo/runs.ts");
const { listPendingApprovals } = await import("../../src/db/repo/approvals.ts");
const { createLiveCanUseTool, resolvePendingApproval } = await import(
  "../../src/server/approvals.ts"
);
const { runPlanner } = await import("../../src/agent/planner.ts");

type Db = ReturnType<typeof openDb>;

let dir: string;
let db: Db;
let task: ReturnType<typeof createTask>;
let project: ReturnType<typeof createProject>;
/** The options the planner passed to runSession. */
let sessionInput: Record<string, unknown>;

const QUESTION = "Should the rate limiter be per-IP or per-account?";
const ASK_INPUT = {
  questions: [
    {
      question: QUESTION,
      header: "Limiter scope",
      options: [
        { label: "Per-IP", description: "Simplest, no auth needed." },
        { label: "Per-account", description: "Fairer behind shared NATs." },
      ],
      multiSelect: false,
    },
  ],
};

function plan(makeCanUseTool?: (runId: number) => CanUseTool) {
  return runPlanner({
    db,
    task,
    project,
    model: "opus",
    maxTurns: 5,
    maxBudgetUsd: 1,
    ...(makeCanUseTool ? { makeCanUseTool } : {}),
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "autocode-planner-test-"));
  db = openDb(path.join(dir, "test.db"));
  project = createProject(db, { name: "demo", repoPath: dir, setupCommand: null });
  task = createTask(db, { projectId: project.id, title: "rate limiter", description: "add one" });

  runSessionMock.mockReset();
  runSessionMock.mockImplementation(async (input: Record<string, unknown>) => {
    sessionInput = input;
    // Ends the run before plan parsing; this test is about the wiring in.
    return { ok: false, errorSummary: "stubbed" };
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("planner permission callback", () => {
  it("binds the callback to the planning run it just created", async () => {
    const seen: number[] = [];
    const stub: CanUseTool = async () => ({ behavior: "allow" });

    await plan((runId) => {
      seen.push(runId);
      return stub;
    });

    const planningRun = listRuns(db, task.id).find((r) => r.phase === "planning")!;
    expect(seen).toEqual([planningRun.id]);
    expect(sessionInput.canUseTool).toBe(stub);
    // The read-only guarantees are untouched by the addition.
    expect(sessionInput.permissionMode).toBe("plan");
    expect(sessionInput.disallowedTools).toContain("Write");
  });

  it("passes no callback at all when none is supplied", async () => {
    await plan();
    expect(sessionInput).not.toHaveProperty("canUseTool");
  });

  it("files the agent's question against the planning run, answerable from the task page", async () => {
    await plan((runId) =>
      createLiveCanUseTool({ db, runId, pendingTimeoutMs: 60_000, fanout: () => {} })
    );
    const planningRun = listRuns(db, task.id).find((r) => r.phase === "planning")!;
    const canUseTool = sessionInput.canUseTool as CanUseTool;

    const decision = canUseTool("AskUserQuestion", ASK_INPUT, {
      signal: new AbortController().signal,
      toolUseID: "toolu_1",
      requestId: "req_1",
    });

    // The task page polls this endpoint for the run it is watching.
    const [pending] = listPendingApprovals(db, planningRun.id);
    expect(pending?.tool_name).toBe("AskUserQuestion");

    resolvePendingApproval(pending!.id, {
      decision: "allow",
      rememberScope: "once",
      answers: { [QUESTION]: "Per-account" },
    });

    const result = (await decision) as { updatedInput?: { answers?: Record<string, string> } };
    expect(result.updatedInput?.answers).toEqual({ [QUESTION]: "Per-account" });
  });
});
