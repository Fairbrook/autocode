import path from "node:path";
import type { Condition, FilterContext, Segment } from "./types.ts";
import { checkContainment, canonicalize } from "./path-guard.ts";
import { hasNonLoopbackTarget } from "./network-guard.ts";

/**
 * Evaluates a Condition against either a Bash Segment or a direct file-path
 * tool call (Write/Edit/NotebookEdit — segment is undefined there). This is
 * the second extensibility axis from the plan: register a new `kind` here
 * for anything that needs real logic rather than a pattern match.
 */
export function evaluateCondition(
  cond: Condition,
  ctx: FilterContext,
  segment: Segment | undefined
): boolean {
  switch (cond.kind) {
    case "argv0":
      return segment !== undefined && cond.any.includes(segment.argv0);

    case "argv0Sub": {
      if (segment === undefined) return false;
      if (segment.argv0 !== cond.cmd) return false;
      const sub = segment.argvAfterWrappers[1];
      return sub !== undefined && cond.sub.includes(sub);
    }

    case "hasFlag": {
      if (segment === undefined) return false;
      if (cond.cmd !== undefined && segment.argv0 !== cond.cmd) return false;
      return segment.argvAfterWrappers.some((a) => cond.flags.includes(a));
    }

    case "argvRegex": {
      if (segment === undefined) return false;
      const re = new RegExp(cond.pattern, cond.flags);
      if (cond.index !== undefined) {
        const arg = segment.argvAfterWrappers[cond.index];
        return arg !== undefined && re.test(arg);
      }
      return segment.argvAfterWrappers.some((a) => re.test(a));
    }

    case "rawRegex": {
      const re = new RegExp(cond.pattern, cond.flags);
      if (segment !== undefined) return re.test(segment.raw);
      const command = typeof ctx.toolInput.command === "string" ? ctx.toolInput.command : "";
      return re.test(command);
    }

    case "inputField": {
      const value = getByPath(ctx.toolInput, cond.path);
      if (cond.exists !== undefined) return (value !== undefined) === cond.exists;
      if (cond.equals !== undefined) return value === cond.equals;
      return value !== undefined && value !== false && value !== null;
    }

    case "pathEscapes": {
      const candidates = collectPathCandidates(ctx, segment);
      if (candidates.length === 0) return false;
      return candidates.some((p) => {
        const result = checkContainment(p, ctx.writeRoots, ctx.denyWriteRoots);
        return !result.contained;
      });
    }

    case "gitDirWrite": {
      const candidates = collectPathCandidates(ctx, segment);
      return candidates.some((p) => {
        const abs = canonicalize(p);
        const parts = abs.split(path.sep);
        const gitIdx = parts.lastIndexOf(".git");
        if (gitIdx === -1) return false;
        const inHooks = parts[gitIdx + 1] === "hooks";
        const isConfig = parts[parts.length - 1] === "config" && gitIdx === parts.length - 2;
        return inHooks || isConfig;
      });
    }

    case "nonLoopbackTarget":
      return segment !== undefined && hasNonLoopbackTarget(segment);

    case "redirectsOutsideRoots": {
      if (segment === undefined) return false;
      return segment.redirects.some((r) => {
        const result = checkContainment(r.target, ctx.writeRoots, ctx.denyWriteRoots);
        return !result.contained;
      });
    }

    case "all":
      return cond.of.every((c) => evaluateCondition(c, ctx, segment));
    case "any":
      return cond.of.some((c) => evaluateCondition(c, ctx, segment));
    case "not":
      return !evaluateCondition(cond.of, ctx, segment);
  }
}

function getByPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** For Write/Edit/NotebookEdit, the target path comes from tool_input. For Bash, from write-ish argv positions and redirect targets. */
function collectPathCandidates(ctx: FilterContext, segment: Segment | undefined): string[] {
  const out: string[] = [];
  if (typeof ctx.toolInput.file_path === "string") out.push(ctx.toolInput.file_path);
  if (typeof ctx.toolInput.notebook_path === "string") out.push(ctx.toolInput.notebook_path);
  if (segment) {
    for (const r of segment.redirects) out.push(r.target);
    out.push(...writeArgPathsForSegment(segment));
  }
  return out;
}

const WRITE_COMMANDS_WITH_TARGET_LAST_ARG = new Set([
  "tee",
  "cp",
  "mv",
  "install",
  "truncate",
]);

function writeArgPathsForSegment(segment: Segment): string[] {
  const argv0 = segment.argv0;
  const rawArgs = segment.argvAfterWrappers.slice(1);
  const args = rawArgs.filter((a) => !a.startsWith("-"));

  if (WRITE_COMMANDS_WITH_TARGET_LAST_ARG.has(argv0) && args.length > 0) {
    return [args[args.length - 1] ?? ""].filter(Boolean);
  }
  if (argv0 === "sed" && rawArgs.some((a) => a === "-i" || a.startsWith("-i"))) {
    // sed -i edits its file args in place — everything after the script arg.
    return args.slice(1);
  }
  if (argv0 === "chmod" || argv0 === "chown") {
    // Mutating permissions/ownership is a write-shaped mutation too — check
    // the target the same way as an actual content write.
    return args.length > 0 ? [args[args.length - 1] ?? ""].filter(Boolean) : [];
  }
  if (argv0 === "rm" && rawArgs.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive")) {
    // Only recursive removal is treated as a "write" target for containment
    // purposes — a non-recursive `rm somefile` outside the worktree isn't
    // reachable anyway since relative paths resolve against cwd, and this
    // keeps plain single-file removal from needing special-casing.
    return args;
  }
  if ((argv0 === "curl" || argv0 === "wget") && rawArgs.length > 0) {
    const out: string[] = [];
    for (let i = 0; i < rawArgs.length; i += 1) {
      const a = rawArgs[i];
      if (a === "-o" || a === "-O" || a === "--output") {
        const val = rawArgs[i + 1];
        if (val && !val.startsWith("-")) out.push(val);
      } else if (a?.startsWith("--output=")) {
        out.push(a.slice("--output=".length));
      }
    }
    return out;
  }
  return [];
}
