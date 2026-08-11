export type Layer = "hard" | "category" | "plan";
export type Decision = "deny" | "allow" | "ask";

export interface Redirect {
  op: string; // '>' | '>>' | '<' | '<>' etc.
  target: string;
}

export interface Segment {
  /** Best-effort reconstruction of this segment's text, for audit logging and rawRegex. */
  raw: string;
  /** Full tokenized argv for this segment, including any wrapper prefix (env, nohup, timeout, ...). */
  argv: string[];
  /** Basename of the real command after peeling known wrapper prefixes. */
  argv0: string;
  /** The wrapped command's own argv (argv0 + its args), i.e. argv with the wrapper prefix peeled off. */
  argvAfterWrappers: string[];
  redirects: Redirect[];
  /** Set when this segment could not be confidently statically analyzed (should route to `ask`). */
  unparseable?: boolean;
  /** Set when this segment came from a $(...) / `...` / `sh -c '...'` substitution, for audit context. */
  fromSubstitution?: boolean;
}

export type Condition =
  | { kind: "argv0"; any: string[] }
  | { kind: "argv0Sub"; cmd: string; sub: string[] }
  | { kind: "hasFlag"; cmd?: string; flags: string[] }
  | { kind: "argvRegex"; index?: number; pattern: string; flags?: string }
  | { kind: "rawRegex"; pattern: string; flags?: string }
  | { kind: "inputField"; path: string; equals?: unknown; exists?: boolean }
  | { kind: "pathEscapes" }
  | { kind: "gitDirWrite" }
  | { kind: "nonLoopbackTarget" }
  | { kind: "redirectsOutsideRoots" }
  | { kind: "all"; of: Condition[] }
  | { kind: "any"; of: Condition[] }
  | { kind: "not"; of: Condition };

export interface Rule {
  id: string;
  description: string;
  layer: Layer;
  decision: Decision;
  /** Defaults to ['Bash'] when omitted. */
  tools?: string[];
  when: Condition;
  /**
   * Marks a rule as a last-resort default (the 99-fallthrough.json rules):
   * it is only considered when NO other, more specific rule matched this
   * segment/call at all. Without this, a catch-all `{kind:'all', of:[]}`
   * "ask" rule would always co-match alongside every specific "allow" rule
   * and — under normal deny/ask/allow precedence — silently override every
   * allow decision in the whole rule set, which is not what "fallthrough"
   * is supposed to mean.
   */
  isFallback?: boolean;
  /**
   * Only meaningful on `decision: "allow"` rules matched against `Bash`.
   * When true, the engine injects `dangerouslyDisableSandbox: true` into
   * the tool call itself — this is how dev-servers/playwright/containers
   * (which the kernel sandbox cannot support across separate tool calls;
   * see docs/SANDBOX-FINDINGS.md) get to run at all. This is categorically
   * different from the model requesting the flag itself: the hard-deny
   * check for a model-supplied `dangerouslyDisableSandbox` runs against the
   * ORIGINAL tool input, before any rule gets to set this.
   */
  sandboxOverride?: boolean;
}

/** Everything a predicate/rule needs to know about the run it's evaluating, beyond the segment/input itself. */
export interface FilterContext {
  toolName: string;
  /** Raw tool_input for the call, e.g. { command } for Bash, { file_path } for Write/Edit. */
  toolInput: Record<string, unknown>;
  /** Allowed write roots: worktree, scratch dir, and (if commits are permitted) the repo's .git dir. */
  writeRoots: string[];
  /** Paths that must never be written even if under a writeRoot (e.g. .git/hooks, .git/config). */
  denyWriteRoots: string[];
  /** Domains allowed for network access (project baseline + plan-approved additions). */
  allowedDomains: string[];
}

export interface RuleMatch {
  rule: Rule;
  /** Which segment (if any) matched, for audit logging. */
  segment?: Segment;
}

export type FinalDecision =
  | { decision: "allow"; matches: RuleMatch[]; sandboxOverride: boolean }
  | { decision: "deny"; matches: RuleMatch[]; reason: string }
  | { decision: "ask"; matches: RuleMatch[]; reason: string };
