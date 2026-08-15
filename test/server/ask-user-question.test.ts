import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, type Db } from "../../src/db/index.ts";
import { createProject } from "../../src/db/repo/projects.ts";
import { createTask } from "../../src/db/repo/tasks.ts";
import { createRun } from "../../src/db/repo/runs.ts";
import { getApprovalRequest, listPendingApprovals } from "../../src/db/repo/approvals.ts";
import { createLiveCanUseTool, resolvePendingApproval } from "../../src/server/approvals.ts";

/**
 * AskUserQuestion arrives on the same approval path as every other tool, but
 * allow/deny is not an answer to it: the choice has to come back on the tool's
 * own input, or the agent decides for itself.
 */

let dir: string;
let db: Db;
let runId: number;
let canUseTool: ReturnType<typeof createLiveCanUseTool>;

const QUESTION = "Should I leave .env.local in the worktree or delete it?";
const SECOND_QUESTION = "Which package manager should the setup command use?";

const ASK_INPUT = {
  questions: [
    {
      question: QUESTION,
      header: "Keep .env.local?",
      options: [
        { label: "Leave it", description: "Gitignored, so it can't be committed." },
        { label: "Delete it", description: "Keep the worktree exactly as planned." },
      ],
      multiSelect: false,
    },
  ],
};

function ask(toolName: string, toolInput: Record<string, unknown>) {
  return canUseTool(toolName, toolInput, {
    signal: new AbortController().signal,
    toolUseID: "toolu_1",
    requestId: "req_1",
  });
}

/** The approval the agent is blocked on right now. */
function pendingId(): number {
  const [pending] = listPendingApprovals(db, runId);
  if (!pending) throw new Error("no pending approval");
  return pending.id;
}

/** Waits for the request to reach the pending table — canUseTool writes it before it blocks. */
async function waitForPending(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (listPendingApprovals(db, runId).length > 0) return pendingId();
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the approval request never appeared");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "autocode-ask-test-"));
  db = openDb(path.join(dir, "test.db"));
  const project = createProject(db, { name: "demo", repoPath: dir, setupCommand: null });
  const task = createTask(db, { projectId: project.id, title: "t", description: "d" });
  const run = createRun(db, {
    taskId: task.id,
    phase: "implementation",
    model: "sonnet",
    cwd: dir,
  });
  runId = run.id;
  canUseTool = createLiveCanUseTool({
    db,
    runId,
    pendingTimeoutMs: 60_000,
    fanout: () => {},
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("AskUserQuestion approvals", () => {
  it("hands the chosen option back to the tool", async () => {
    const decision = ask("AskUserQuestion", ASK_INPUT);
    const id = await waitForPending();

    expect(
      resolvePendingApproval(id, {
        decision: "allow",
        rememberScope: "once",
        answers: { [QUESTION]: "Leave it" },
      })
    ).toBe(true);

    const result = (await decision)!;
    expect(result.behavior).toBe("allow");
    // The answers ride on the tool's own input, which is where it reads them.
    expect((result as { updatedInput?: Record<string, unknown> }).updatedInput).toEqual({
      ...ASK_INPUT,
      answers: { [QUESTION]: "Leave it" },
    });

    // And the decision itself is recorded, not just the fact that it was allowed.
    const row = getApprovalRequest(db, id)!;
    expect(row.status).toBe("allowed");
    expect(row.resolution_note).toBe(`${QUESTION} → Leave it`);
  });

  it("answers each question of a multi-question ask", async () => {
    const input = {
      questions: [
        ...ASK_INPUT.questions,
        {
          question: SECOND_QUESTION,
          header: "Package manager",
          options: [
            { label: "pnpm", description: "What the repo uses." },
            { label: "npm", description: "The default." },
          ],
          multiSelect: true,
        },
      ],
    };
    const decision = ask("AskUserQuestion", input);
    const id = await waitForPending();

    resolvePendingApproval(id, {
      decision: "allow",
      rememberScope: "once",
      // Multi-select answers are comma-separated, per the tool's contract.
      answers: { [QUESTION]: "Delete it", [SECOND_QUESTION]: "pnpm, npm" },
    });

    const result = (await decision) as { updatedInput?: { answers?: Record<string, string> } };
    expect(result.updatedInput?.answers).toEqual({
      [QUESTION]: "Delete it",
      [SECOND_QUESTION]: "pnpm, npm",
    });
  });

  it("drops answers that don't belong to a question the agent asked", async () => {
    const decision = ask("AskUserQuestion", ASK_INPUT);
    const id = await waitForPending();

    resolvePendingApproval(id, {
      decision: "allow",
      rememberScope: "once",
      answers: { "Some other question entirely?": "yes", [QUESTION]: "  " },
    });

    const result = (await decision) as { behavior: string; updatedInput?: unknown };
    // Nothing survived the match, so the tool is allowed with its input as-is
    // rather than being fed something the agent never asked about.
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toBeUndefined();
  });

  it("still allows a plain approval with no answers at all", async () => {
    const decision = ask("AskUserQuestion", ASK_INPUT);
    const id = await waitForPending();

    resolvePendingApproval(id, { decision: "allow", rememberScope: "once" });

    const result = (await decision) as { behavior: string; updatedInput?: unknown };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toBeUndefined();
  });

  it("denies without touching the input", async () => {
    const decision = ask("AskUserQuestion", ASK_INPUT);
    const id = await waitForPending();

    resolvePendingApproval(id, {
      decision: "deny",
      rememberScope: "once",
      note: "I'll decide later",
      answers: { [QUESTION]: "Leave it" },
    });

    const result = (await decision) as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe("I'll decide later");
    expect(getApprovalRequest(db, id)?.status).toBe("denied");
  });

  it("ignores answers sent for a tool that isn't a question", async () => {
    const decision = ask("Bash", { command: "ls" });
    const id = await waitForPending();

    resolvePendingApproval(id, {
      decision: "allow",
      rememberScope: "once",
      answers: { [QUESTION]: "Leave it" },
    });

    const result = (await decision) as { behavior: string; updatedInput?: Record<string, unknown> };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput?.answers).toBeUndefined();
  });
});
