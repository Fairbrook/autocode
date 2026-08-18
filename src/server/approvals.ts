import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.ts";
import {
  createApprovalRequest,
  resolveApprovalRequest,
  expireOrphanedPendingApprovals,
} from "../db/repo/approvals.ts";
import { appendRunLog } from "../db/repo/log.ts";
import { isRunUnattended } from "../db/repo/runs.ts";
import type { RememberScope } from "../types.ts";
import type { Fanout } from "../notify/index.ts";
import { withLocalServiceProxyEnv } from "../filter/proxy-env.ts";

interface PendingResolution {
  decision: "allow" | "deny";
  rememberScope: RememberScope;
  note?: string;
  /**
   * Only meaningful for AskUserQuestion: the user's choice per question, keyed
   * by the question's own text (multi-select answers comma-separated), exactly
   * the shape the tool's `answers` field expects.
   */
  answers?: Record<string, string>;
}

/** The tool the SDK gives the agent for asking the human a multiple-choice question. */
const ASK_USER_QUESTION = "AskUserQuestion";
/** A free-text "Other" answer is the user's own words, so it needs a ceiling. */
const MAX_ANSWER_LENGTH = 2000;

interface AskedQuestion {
  question?: unknown;
}

/**
 * Matches the submitted answers back to the questions that were actually
 * asked. Approving an AskUserQuestion without answering it is what the UI used
 * to do — the tool then returned nothing useful and the agent picked for
 * itself — so the answers are threaded through `updatedInput`, which is where
 * the SDK reads them from ("User answers collected by the permission
 * component").
 *
 * Anything that doesn't line up with a real question is dropped rather than
 * passed on: the tool result is model-visible input, and it should contain the
 * user's decisions, not whatever a request body happened to carry.
 */
function matchAnswersToQuestions(
  toolInput: unknown,
  answers: Record<string, string> | undefined
): Record<string, string> | null {
  if (!answers) return null;
  const questions = (toolInput as { questions?: AskedQuestion[] } | null)?.questions;
  if (!Array.isArray(questions)) return null;

  const matched: Record<string, string> = {};
  for (const q of questions) {
    if (typeof q?.question !== "string") continue;
    const answer = answers[q.question];
    if (typeof answer !== "string") continue;
    const trimmed = answer.trim().slice(0, MAX_ANSWER_LENGTH);
    if (trimmed) matched[q.question] = trimmed;
  }
  return Object.keys(matched).length > 0 ? matched : null;
}

function firstQuestionText(toolInput: unknown): string | null {
  const first = (toolInput as { questions?: AskedQuestion[] } | null)?.questions?.[0];
  return typeof first?.question === "string" ? first.question : null;
}

/** What the answers were, in one line, so the approval row records the decision and not just "allowed". */
function summarizeAnswers(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([question, answer]) => `${question} → ${answer}`)
    .join(" · ");
}

interface ParkedApproval {
  runId: number;
  resolve: (res: PendingResolution) => void;
}

const pendingResolvers = new Map<number, ParkedApproval>();

/** The resolution note that marks a decision as the flag's rather than a person's. */
export const UNATTENDED_NOTE = "Auto-allowed — the run is unattended";

/** Called once at boot: any row still 'pending' belongs to a process lifetime that's gone. */
export function reconcileOrphanedApprovalsOnBoot(db: Db): number {
  return expireOrphanedPendingApprovals(db);
}

export function resolvePendingApproval(
  approvalId: number,
  resolution: PendingResolution
): boolean {
  const parked = pendingResolvers.get(approvalId);
  if (!parked) return false;
  parked.resolve(resolution);
  pendingResolvers.delete(approvalId);
  return true;
}

/**
 * Turning unattended mode on has to catch up with whatever the agent is
 * already blocked on: the tool call that made the user reach for the button is
 * usually one of them, and leaving it parked would be the one request
 * unattended mode failed to answer.
 *
 * Returns how many were released.
 */
export function autoAllowParkedApprovals(runId: number): number {
  let released = 0;
  for (const [approvalId, parked] of [...pendingResolvers]) {
    if (parked.runId !== runId) continue;
    if (resolvePendingApproval(approvalId, {
      decision: "allow",
      rememberScope: "once",
      note: UNATTENDED_NOTE,
    })) {
      released++;
    }
  }
  return released;
}

export interface CreateCanUseToolInput {
  db: Db;
  runId: number;
  pendingTimeoutMs: number;
  fanout: Fanout;
  /**
   * Hosts this project's dev services listen on. A command that reaches the
   * human-in-the-loop path needs the same NO_PROXY narrowing an auto-allowed
   * one gets from the filter hook (src/filter/proxy-env.ts) — without it,
   * approving a test command would still leave it unable to connect. Applied
   * after the decision, so the user approves the command they actually wrote.
   */
  localServiceHosts?: string[];
}

/**
 * The live human-in-the-loop "ask" flow (constraint #8). Only reached for
 * tool calls the PreToolUse filter hook couldn't resolve to allow/deny —
 * everything pre-approved by a rule never gets here (see src/filter/hooks.ts).
 */
export function createLiveCanUseTool(input: CreateCanUseToolInput): CanUseTool {
  const { db, runId, pendingTimeoutMs, fanout } = input;
  const localServiceHosts = input.localServiceHosts ?? [];

  return async (toolName, toolInput, opts) => {
    const request = createApprovalRequest(db, {
      runId,
      toolUseId: opts.toolUseID ?? null,
      toolName,
      title: opts.title ?? null,
      toolInput,
      reason: opts.decisionReason ?? null,
      blockedPath: opts.blockedPath ?? null,
    });

    appendRunLog(db, runId, "approval_request", request);

    // Unattended mode answers before anyone is asked to. The request row is
    // still written first, so the audit trail shows what was allowed and on
    // whose behalf; no notification goes out, because not being interrupted is
    // the entire point. An AskUserQuestion allowed this way carries no answers,
    // which is the SDK's "you decide" — the agent picks for itself and keeps
    // going, rather than being blocked on a person who has stepped away.
    if (isRunUnattended(db, runId)) {
      resolveApprovalRequest(db, request.id, "allowed", {
        rememberScope: "once",
        note: UNATTENDED_NOTE,
      });
      appendRunLog(db, runId, "approval_resolved", {
        id: request.id,
        decision: "allow",
        rememberScope: "once",
        note: UNATTENDED_NOTE,
        unattended: true,
      });
      return allowWith(toolName, toolInput, null, localServiceHosts);
    }

    // A question is worth reading in the notification itself: it's the one
    // "approval" whose whole content is the thing the user has to decide.
    const asked = toolName === ASK_USER_QUESTION ? firstQuestionText(toolInput) : null;
    fanout({
      kind: "approval_needed",
      runId,
      approvalId: request.id,
      title: request.title ?? (asked ? "The agent has a question" : `${toolName} requested`),
      body: asked ?? opts.decisionReason ?? "Waiting for your decision",
    });

    const resolution = await new Promise<PendingResolution>((resolve) => {
      pendingResolvers.set(request.id, { runId, resolve });

      const timeout = setTimeout(() => {
        if (pendingResolvers.delete(request.id)) {
          resolve({ decision: "deny", rememberScope: "once", note: "Timed out waiting for a response" });
        }
      }, pendingTimeoutMs);
      opts.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        if (pendingResolvers.delete(request.id)) {
          resolve({ decision: "deny", rememberScope: "once", note: "Tool call aborted" });
        }
      });
    });

    const answers =
      toolName === ASK_USER_QUESTION
        ? matchAnswersToQuestions(toolInput, resolution.answers)
        : null;

    resolveApprovalRequest(
      db,
      request.id,
      resolution.decision === "allow" ? "allowed" : "denied",
      {
        rememberScope: resolution.rememberScope,
        note: resolution.note ?? (answers ? summarizeAnswers(answers) : undefined),
      }
    );
    appendRunLog(db, runId, "approval_resolved", { id: request.id, ...resolution });

    if (resolution.decision === "allow") {
      return allowWith(toolName, toolInput, answers, localServiceHosts);
    }
    return { behavior: "deny", message: resolution.note ?? "Denied by user" };
  };
}

/**
 * The one shape an allowed tool call comes back in, whoever allowed it.
 * Answers ride back on the tool's own input — that is how the SDK hands a
 * choice to AskUserQuestion — and a Bash command gets the same NO_PROXY
 * narrowing the filter hook gives an auto-allowed one.
 */
function allowWith(
  toolName: string,
  toolInput: unknown,
  answers: Record<string, string> | null,
  localServiceHosts: string[]
): { behavior: "allow"; updatedInput?: Record<string, unknown> } {
  if (answers) {
    return {
      behavior: "allow",
      updatedInput: { ...(toolInput as Record<string, unknown>), answers },
    };
  }
  const updatedInput =
    toolName === "Bash"
      ? withLocalServiceProxyEnv(toolInput as Record<string, unknown>, localServiceHosts)
      : undefined;
  return updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" };
}
