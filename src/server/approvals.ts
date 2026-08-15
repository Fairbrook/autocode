import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../db/index.ts";
import {
  createApprovalRequest,
  resolveApprovalRequest,
  expireOrphanedPendingApprovals,
} from "../db/repo/approvals.ts";
import { appendRunLog } from "../db/repo/log.ts";
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

const pendingResolvers = new Map<number, (res: PendingResolution) => void>();

/** Called once at boot: any row still 'pending' belongs to a process lifetime that's gone. */
export function reconcileOrphanedApprovalsOnBoot(db: Db): number {
  return expireOrphanedPendingApprovals(db);
}

export function resolvePendingApproval(
  approvalId: number,
  resolution: PendingResolution
): boolean {
  const resolver = pendingResolvers.get(approvalId);
  if (!resolver) return false;
  resolver(resolution);
  pendingResolvers.delete(approvalId);
  return true;
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
      pendingResolvers.set(request.id, resolve);

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
      // The answers ride back on the tool's own input — that is how the SDK
      // hands a choice to AskUserQuestion.
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
    return { behavior: "deny", message: resolution.note ?? "Denied by user" };
  };
}
