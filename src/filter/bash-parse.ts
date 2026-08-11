import { parse as shellQuoteParse } from "shell-quote";
import type { ParseEntry } from "shell-quote";
import path from "node:path";
import type { Redirect, Segment } from "./types.ts";

const MAX_RECURSION_DEPTH = 6;

const SEPARATOR_OPS = new Set([";", "&&", "||", "|", "&", "|&"]);
// ">&" (fd-duplication, e.g. the `>&1` in `2>&1`) is a genuinely distinct
// operator from "&>" (redirect both stdout+stderr, e.g. `&> out.log`) —
// shell-quote emits the former for `2>&1`; confirmed empirically, since
// the naive-looking "same characters reversed" assumption is wrong here.
const REDIRECT_OPS = new Set([">", ">>", "<", "<>", "&>", "&>>", ">&"]);
const FD_NUMBER = /^\d+$/;

/**
 * Wrappers that pass execution through to a real command. Each has its own
 * "how many leading args does it eat before the real command" logic in
 * `peelWrapper` below — this set is just membership.
 */
const WRAPPERS = new Set([
  "env",
  "nohup",
  "time",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
  "xargs",
  "command",
  "builtin",
]);

const SHELL_DASH_C = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

function basename(p: string): string {
  try {
    return path.basename(p);
  } catch {
    return p;
  }
}

/**
 * Scan raw text for `$(...)` and `` `...` `` substitutions, respecting
 * single-quote regions (the one shell construct that reliably disables all
 * expansion — content inside '...' is inert and must not be recursed into).
 * Returns the text with each substitution replaced by an inert placeholder
 * (so splitting the outer command on `;`/`&&`/etc. later isn't corrupted by
 * separators living *inside* the substitution), plus the extracted inner
 * command texts to parse recursively.
 *
 * Backtick substitutions are deliberately NOT reconstructed structurally —
 * shell-quote doesn't separate them from surrounding tokens, so precisely
 * finding their boundaries is unreliable. Any backtick in the raw text
 * instead marks the whole command `unparseable` via the `hasBacktick` flag,
 * which routes to `ask` rather than risk mis-parsing an escape.
 */
function extractSubstitutions(raw: string): {
  text: string;
  nested: string[];
  hasBacktick: boolean;
} {
  let out = "";
  const nested: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let hasBacktick = false;
  let i = 0;
  let placeholderIndex = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "`" && !inSingle) {
      hasBacktick = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      i += 1;
      continue;
    }
    if (!inSingle && ch === "$" && raw[i + 1] === "(") {
      // Balanced-paren scan for the matching close, from position i+2.
      let depth = 1;
      let j = i + 2;
      while (j < raw.length && depth > 0) {
        if (raw[j] === "(") depth += 1;
        else if (raw[j] === ")") depth -= 1;
        j += 1;
      }
      if (depth !== 0) {
        // Unbalanced — can't safely extract. Bail: keep raw text as-is from
        // here on and let downstream tokenization/argv checks fail closed.
        out += raw.slice(i);
        i = raw.length;
        break;
      }
      const inner = raw.slice(i + 2, j - 1);
      nested.push(inner);
      placeholderIndex += 1;
      out += `__AUTOCODE_SUBSHELL_${placeholderIndex}__`;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { text: out, nested, hasBacktick };
}

/**
 * Peel a known wrapper command off the front of argv, returning the real
 * command's own argv0 + args. Handles env's KEY=VALUE prefix, timeout's
 * duration argument, and generic flag-eating for the rest. If nothing
 * remains after peeling (e.g. bare `xargs` with no explicit command), the
 * wrapper name itself becomes argv0 — it won't match any known-good rule
 * and falls through to `ask`, which is the safe outcome.
 */
function peelWrappers(argv: string[]): { argv0: string; rest: string[] } {
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const base = basename(tok);
    if (!WRAPPERS.has(base)) break;
    i += 1;
    if (base === "env") {
      while (
        i < argv.length &&
        (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? "") || (argv[i] ?? "").startsWith("-"))
      ) {
        i += 1;
      }
    } else if (base === "timeout") {
      while (i < argv.length && (argv[i] ?? "").startsWith("-")) i += 1;
      if (i < argv.length && /^[0-9.]+[smhd]?$/.test(argv[i] ?? "")) i += 1;
    } else {
      // nohup, time, nice, ionice, stdbuf, xargs, command, builtin: eat flags only.
      while (i < argv.length && (argv[i] ?? "").startsWith("-")) i += 1;
    }
  }
  if (i >= argv.length) {
    const last = argv[argv.length - 1] ?? "";
    return { argv0: basename(last), rest: [] };
  }
  return { argv0: basename(argv[i] ?? ""), rest: argv.slice(i) };
}

function buildSegmentFromTokens(
  tokens: ParseEntry[],
  depth: number
): { segment: Segment; nestedFromShC: Segment[] } {
  const argv: string[] = [];
  const redirects: Redirect[] = [];
  let pendingRedirectOp: string | null = null;
  // True when the plain string token just before the current redirect
  // operator was a bare number (the `2` in `2>&1`) — that token is the
  // redirect's source file descriptor, not a separate argv element, and
  // gets retroactively popped off argv once we see the operator that
  // claims it.
  let pendingFdWasPopped = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (typeof tok === "string") {
      if (pendingRedirectOp) {
        // A purely numeric target (`2>&1`'s trailing `1`) duplicates one
        // fd onto another — there is no filesystem path involved, so
        // don't record it as a containment-checkable redirect at all.
        if (!FD_NUMBER.test(tok)) {
          redirects.push({ op: pendingRedirectOp, target: tok });
        }
        pendingRedirectOp = null;
        pendingFdWasPopped = false;
      } else {
        argv.push(tok);
      }
      continue;
    }
    if ("comment" in tok) continue;
    if ("op" in tok && typeof tok.op === "string") {
      if (REDIRECT_OPS.has(tok.op)) {
        // Pop a bare-number token that immediately precedes this operator
        // (the source fd, e.g. `2` in `2>&1`) back off argv — it was
        // provisionally pushed as a plain string above, one iteration ago,
        // before we knew a redirect operator would claim it.
        const last = argv[argv.length - 1];
        if (last !== undefined && FD_NUMBER.test(last) && !pendingFdWasPopped) {
          argv.pop();
        }
        pendingRedirectOp = tok.op;
        pendingFdWasPopped = true;
        continue;
      }
      // Any other stray op token (glob, paren leftovers, etc.) inside a
      // segment we couldn't cleanly split — treat conservatively.
      argv.push(String(tok.op));
      continue;
    }
  }

  const raw = argv.join(" ");
  const { argv0, rest } = peelWrappers(argv);

  const nestedFromShC: Segment[] = [];
  if (SHELL_DASH_C.has(argv0) && depth < MAX_RECURSION_DEPTH) {
    const cIndex = rest.indexOf("-c");
    const payload = cIndex >= 0 ? rest[cIndex + 1] : undefined;
    if (typeof payload === "string") {
      nestedFromShC.push(...parseBashCommand(payload, depth + 1));
    }
  }

  const segment: Segment = {
    raw,
    argv,
    argv0,
    argvAfterWrappers: rest,
    redirects,
  };
  return { segment, nestedFromShC };
}

/**
 * Tokenize a bash command string into pipeline `Segment`s, recursing into
 * `$(...)`, `` `...` ``, and `sh -c '...'`-style nested commands. Every
 * segment must independently pass filter evaluation for the whole call to
 * be allowed — see engine.ts.
 */
export function parseBashCommand(raw: string, depth = 0): Segment[] {
  if (depth >= MAX_RECURSION_DEPTH) {
    return [
      {
        raw,
        argv: [],
        argv0: "",
        argvAfterWrappers: [],
        redirects: [],
        unparseable: true,
        fromSubstitution: depth > 0,
      },
    ];
  }

  const normalized = raw.replace(/\r\n|\n/g, ";");
  const { text, nested, hasBacktick } = extractSubstitutions(normalized);

  if (hasBacktick) {
    return [
      {
        raw,
        argv: [],
        argv0: "",
        argvAfterWrappers: [],
        redirects: [],
        unparseable: true,
      },
    ];
  }

  let tokens: ParseEntry[];
  try {
    tokens = shellQuoteParse(text);
  } catch {
    return [
      {
        raw,
        argv: [],
        argv0: "",
        argvAfterWrappers: [],
        redirects: [],
        unparseable: true,
      },
    ];
  }

  const segments: Segment[] = [];
  let current: ParseEntry[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const { segment, nestedFromShC } = buildSegmentFromTokens(current, depth);
    segments.push(segment);
    segments.push(...nestedFromShC);
    current = [];
  };

  for (const tok of tokens) {
    if (typeof tok !== "string" && "op" in tok && SEPARATOR_OPS.has(String(tok.op))) {
      flush();
      continue;
    }
    current.push(tok);
  }
  flush();

  for (const innerRaw of nested) {
    const innerSegments = parseBashCommand(innerRaw, depth + 1);
    for (const s of innerSegments) s.fromSubstitution = true;
    segments.push(...innerSegments);
  }

  if (segments.length === 0) {
    segments.push({
      raw,
      argv: [],
      argv0: "",
      argvAfterWrappers: [],
      redirects: [],
      unparseable: true,
    });
  }

  return segments;
}
