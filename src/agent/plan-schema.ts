import { z } from "zod";

// Base object shape — this is what gets turned into the JSON schema sent to
// the model via `outputFormat`. Keep it free of length/numeric-range
// constraints (see the note on `steps` below); any extra validation the
// harness wants belongs on `PlanOutputSchema` further down, as a
// `.refine()` that only runs client-side after parsing.
const PlanOutputShape = z.object({
  summary: z.string().describe("One to three sentence summary of what will be built"),
  task_category: z.enum(["feature", "bugfix", "refactor", "docs", "maintenance", "infra"]),
  tdd_applies: z
    .boolean()
    .describe("True unless this is a documentation-only or pure-maintenance task"),
  tdd_rationale: z
    .string()
    .describe("Why TDD does or doesn't apply to this specific task"),
  // Plain z.array(...) with no .min(1) — array-length and numeric-range
  // constraints are unreliable with the SDK's structured-output
  // validation; confirmed empirically via scripts/spike-planner.ts (the
  // fully-constrained schema failed structured-output validation after 5
  // retries with no clear error). Validate "at least one step" with zod
  // client-side after parsing instead (see the .refine() below).
  steps: z.array(
    z.object({
      order: z.number(),
      description: z.string(),
    })
  ),
  proposed_commands: z
    .array(
      z.object({
        pattern: z.string().describe("e.g. 'pnpm vitest run' or 'npx playwright test'"),
        why: z.string(),
        category: z.string().describe("free-text grouping, e.g. 'test', 'build', 'dev-server'"),
      })
    )
    .describe("Every shell command this task will need beyond the harness's standing allow-list"),
  proposed_domains: z
    .array(
      z.object({
        domain: z.string().describe("e.g. 'registry.npmjs.org'"),
        why: z.string(),
      })
    )
    .describe("Any external network domain this task will need to reach (package registries, etc.)"),
  risks: z.array(z.string()).default([]),
  files: z
    .array(z.string())
    .default([])
    .describe("Files expected to be created or modified"),
});

// Client-side-only validation, applied after the model's output already
// parsed against the (unconstrained) schema above — never reflected in the
// JSON schema sent to the model.
export const PlanOutputSchema = PlanOutputShape.refine((plan) => plan.steps.length > 0, {
  message: "A plan must have at least one step",
  path: ["steps"],
});

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// The Agent SDK's --json-schema validator chokes on a top-level `$schema`
// key (tries to resolve it as a $ref rather than treating it as the
// standard JSON-Schema meta-field) — confirmed empirically via
// scripts/spike-planner.ts. Strip it before handing the schema to
// `outputFormat`.
const { $schema: _unusedSchemaKey, ...planJsonSchemaWithoutMeta } = z.toJSONSchema(PlanOutputShape);
export const PlanOutputJsonSchema = planJsonSchemaWithoutMeta;
