import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Rule } from "./types.ts";

// Kept structurally loose (not a strict recursive zod schema) — the engine
// only ever reads the fields it defined; a malformed rule file fails fast
// via the JSON.parse + basic shape check below rather than a heavy schema.
const RuleFileSchema = z.array(
  z.object({
    id: z.string(),
    description: z.string(),
    layer: z.enum(["hard", "category", "plan"]),
    decision: z.enum(["deny", "allow", "ask"]),
    tools: z.array(z.string()).optional(),
    sandboxOverride: z.boolean().optional(),
    isFallback: z.boolean().optional(),
    when: z.unknown(),
  })
);

/** Load every `config/rules/*.json` file, in filename order, and flatten into one Rule[]. */
export function loadShippedRules(rulesDir: string): Rule[] {
  const files = readdirSync(rulesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const rules: Rule[] = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(path.join(rulesDir, file), "utf8"));
    const parsed = RuleFileSchema.parse(raw);
    for (const r of parsed) {
      rules.push(r as unknown as Rule);
    }
  }
  return rules;
}

/**
 * Compile a plan's human-approved command list into `plan`-layer allow
 * rules. Each pattern is matched as an exact argv0 (optionally with a
 * required subcommand, `git push` style) — deliberately not a free-form
 * regex, so the plan-review UI can show something a non-programmer user
 * can reason about, and so a plan can never smuggle in a `hard`-layer
 * override (the layer is fixed to `plan` here, which the engine always
 * ranks below `hard`).
 */
export function compilePlanRules(
  approvedCommands: { pattern: string; category?: string | null }[]
): Rule[] {
  return approvedCommands.map((cmd, i) => {
    const parts = cmd.pattern.trim().split(/\s+/);
    const argv0 = parts[0] ?? "";
    const sub = parts[1];
    return {
      id: `plan-${i}-${cmd.pattern}`,
      description: `Plan-approved command: ${cmd.pattern}`,
      layer: "plan",
      decision: "allow",
      when:
        sub !== undefined
          ? { kind: "argv0Sub", cmd: argv0, sub: [sub] }
          : { kind: "argv0", any: [argv0] },
    } satisfies Rule;
  });
}
