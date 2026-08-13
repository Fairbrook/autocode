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
    fanout({
      kind: "approval_needed",
      runId,
      approvalId: request.id,
      title: request.title ?? `${toolName} requested`,
      body: opts.decisionReason ?? "Waiting for your decision",
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

    resolveApprovalRequest(
      db,
      request.id,
      resolution.decision === "allow" ? "allowed" : "denied",
      { rememberScope: resolution.rememberScope, note: resolution.note }
    );
    appendRunLog(db, runId, "approval_resolved", { id: request.id, ...resolution });

    if (resolution.decision === "allow") {
      const updatedInput =
        toolName === "Bash"
          ? withLocalServiceProxyEnv(toolInput as Record<string, unknown>, localServiceHosts)
          : undefined;
      return updatedInput ? { behavior: "allow", updatedInput } : { behavior: "allow" };
    }
    return { behavior: "deny", message: resolution.note ?? "Denied by user" };
  };
}
