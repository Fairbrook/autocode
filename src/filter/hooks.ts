import type { HookCallback, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { decide } from "./engine.ts";
import type { FilterContext, FinalDecision } from "./types.ts";
import type { Rule } from "./types.ts";

export interface FilterHookDeps {
  getRules: () => Rule[];
  getWriteRoots: () => string[];
  getDenyWriteRoots: () => string[];
  getAllowedDomains: () => string[];
  /** Called for every decision, before returning the hook output — this is the audit trail (tool_events table). */
  onDecision: (input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string | undefined;
    result: FinalDecision;
  }) => void;
}

const FILTERED_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit", "TodoWrite"]);

/**
 * Builds the PreToolUse hook callback that wires the filter engine into the
 * Agent SDK. Registered with no matcher (runs on every tool call) — the
 * engine itself decides per-tool-name whether it has an opinion at all;
 * tools outside FILTERED_TOOLS pass through untouched (`{}`, i.e. fall
 * through to the SDK's normal permission evaluation).
 */
export function createFilterPreToolUseHook(deps: FilterHookDeps): HookCallback {
  return async (input: HookInput, toolUseId: string | undefined): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const { tool_name: toolName, tool_input } = input;
    if (!FILTERED_TOOLS.has(toolName)) return {};

    const toolInput = (tool_input ?? {}) as Record<string, unknown>;
    const ctx: FilterContext = {
      toolName,
      toolInput,
      writeRoots: deps.getWriteRoots(),
      denyWriteRoots: deps.getDenyWriteRoots(),
      allowedDomains: deps.getAllowedDomains(),
    };

    const result = decide(deps.getRules(), ctx);
    deps.onDecision({ toolName, toolInput, toolUseId, result });

    if (result.decision === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      };
    }

    if (result.decision === "ask") {
      // MUST be an explicit permissionDecision: "ask", not a bare `{}`
      // pass-through. Confirmed live during Gate 4: with the sandbox
      // enabled, the SDK's own "auto-allow if sandboxed" behavior
      // (docs: sandboxed commands run "without asking your permission")
      // silently approves anything that successfully sandboxes when the
      // hook returns no opinion — canUseTool is never reached and the
      // human-in-the-loop "ask" path (constraint #8) is bypassed entirely.
      // An explicit "ask" here forces canUseTool regardless of sandbox
      // auto-allow, same as a settings.json ask rule would.
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: result.reason,
        },
      };
    }

    // allow
    if (toolName === "Bash" && result.sandboxOverride) {
      const updatedInput = { ...toolInput, dangerouslyDisableSandbox: true };
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "Matched a dev-server/playwright/container rule — running outside the kernel sandbox; see docs/SANDBOX-FINDINGS.md.",
          updatedInput,
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: result.matches.map((m) => m.rule.id).join(", ") || undefined,
      },
    };
  };
}
