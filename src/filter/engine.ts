import { parseBashCommand } from "./bash-parse.ts";
import { evaluateCondition } from "./predicates.ts";
import type {
  FilterContext,
  FinalDecision,
  Rule,
  RuleMatch,
  Segment,
} from "./types.ts";

export interface SegmentDecision {
  decision: "allow" | "deny" | "ask";
  matches: RuleMatch[];
  sandboxOverride: boolean;
  reason: string;
}

function rulesForTool(rules: Rule[], toolName: string): Rule[] {
  return rules.filter((r) => (r.tools ?? ["Bash"]).includes(toolName));
}

/** Evaluate every applicable rule against one segment (or the whole call, when segment is undefined). */
export function decideForSegment(
  rules: Rule[],
  ctx: FilterContext,
  segment: Segment | undefined
): SegmentDecision {
  if (segment?.unparseable) {
    return {
      decision: "ask",
      matches: [],
      sandboxOverride: false,
      reason: `Could not statically analyze this command segment (raw: ${segment.raw || "<empty>"})`,
    };
  }

  const applicable = rulesForTool(rules, ctx.toolName);
  const specific = applicable.filter((r) => !r.isFallback);
  const fallback = applicable.filter((r) => r.isFallback);

  // Two passes: fallback (99-fallthrough.json) rules are last-resort
  // defaults — they only get a vote when nothing more specific matched at
  // all. Without this split, a catch-all "ask" fallback would always
  // co-match alongside every specific "allow" rule and (under normal
  // deny/ask/allow precedence) silently override every allow decision in
  // the whole rule set.
  let matches: RuleMatch[] = [];
  for (const rule of specific) {
    if (evaluateCondition(rule.when, ctx, segment)) {
      matches.push({ rule, segment });
    }
  }
  if (matches.length === 0) {
    for (const rule of fallback) {
      if (evaluateCondition(rule.when, ctx, segment)) {
        matches.push({ rule, segment });
      }
    }
  }

  const hardDeny = matches.find((m) => m.rule.layer === "hard" && m.rule.decision === "deny");
  if (hardDeny) {
    return {
      decision: "deny",
      matches: [hardDeny],
      sandboxOverride: false,
      reason: `[${hardDeny.rule.id}] ${hardDeny.rule.description}`,
    };
  }

  const anyDeny = matches.find((m) => m.rule.decision === "deny");
  if (anyDeny) {
    return {
      decision: "deny",
      matches: [anyDeny],
      sandboxOverride: false,
      reason: `[${anyDeny.rule.id}] ${anyDeny.rule.description}`,
    };
  }

  const anyAsk = matches.find((m) => m.rule.decision === "ask");
  const anyAllow = matches.filter((m) => m.rule.decision === "allow");

  if (anyAsk && anyAllow.length === 0) {
    return {
      decision: "ask",
      matches: [anyAsk],
      sandboxOverride: false,
      reason: `[${anyAsk.rule.id}] ${anyAsk.rule.description}`,
    };
  }
  if (anyAsk && anyAllow.length > 0) {
    // An explicit `ask` rule matching alongside an `allow` rule is treated
    // as "a human should still see this" — ask wins over allow, deny still
    // wins over both (handled above).
    return {
      decision: "ask",
      matches: [anyAsk, ...anyAllow],
      sandboxOverride: false,
      reason: `[${anyAsk.rule.id}] ${anyAsk.rule.description}`,
    };
  }
  if (anyAllow.length > 0) {
    const sandboxOverride = anyAllow.some((m) => m.rule.sandboxOverride === true);
    return {
      decision: "allow",
      matches: anyAllow,
      sandboxOverride,
      reason: anyAllow.map((m) => `[${m.rule.id}]`).join(" "),
    };
  }

  // Nothing matched at all — the shipped 99-fallthrough.json rules should
  // make this unreachable for Bash/Write/Edit/NotebookEdit, but fail safe.
  return {
    decision: "ask",
    matches: [],
    sandboxOverride: false,
    reason: "No filter rule matched this call — failing safe to a human decision.",
  };
}

/**
 * Top-level entry point. For Bash, tokenizes the command into segments and
 * requires every segment to independently allow; any deny anywhere denies
 * the whole call, any ask (or unparseable segment) anywhere asks. For other
 * tools, evaluates once against the tool input directly.
 */
export function decide(rules: Rule[], ctx: FilterContext): FinalDecision {
  if (ctx.toolName !== "Bash") {
    const result = decideForSegment(rules, ctx, undefined);
    return finalize(result);
  }

  const command = typeof ctx.toolInput.command === "string" ? ctx.toolInput.command : "";
  const segments = parseBashCommand(command);

  const decisions = segments.map((seg) => ({
    segment: seg,
    result: decideForSegment(rules, ctx, seg),
  }));

  const denied = decisions.find((d) => d.result.decision === "deny");
  if (denied) {
    return {
      decision: "deny",
      matches: denied.result.matches,
      reason: `${denied.result.reason} (segment: ${denied.segment.raw || "<empty>"})`,
    };
  }

  const asked = decisions.find((d) => d.result.decision === "ask");
  if (asked) {
    return {
      decision: "ask",
      matches: asked.result.matches,
      reason: `${asked.result.reason} (segment: ${asked.segment.raw || "<empty>"})`,
    };
  }

  const allMatches = decisions.flatMap((d) => d.result.matches);
  const sandboxOverride = decisions.some((d) => d.result.sandboxOverride);
  return { decision: "allow", matches: allMatches, sandboxOverride };
}

function finalize(result: SegmentDecision): FinalDecision {
  if (result.decision === "deny") {
    return { decision: "deny", matches: result.matches, reason: result.reason };
  }
  if (result.decision === "ask") {
    return { decision: "ask", matches: result.matches, reason: result.reason };
  }
  return {
    decision: "allow",
    matches: result.matches,
    sandboxOverride: result.sandboxOverride,
  };
}
