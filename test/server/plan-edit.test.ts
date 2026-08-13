import { describe, expect, it } from "vitest";
import { applyPlanEdits } from "../../src/server/plan-edit.ts";
import type { PlanRow } from "../../src/types.ts";

function basePlan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: 1,
    task_id: 1,
    run_id: 1,
    version: 1,
    summary: "Add a rate limiter",
    task_category: "feature",
    tdd_applies: 1,
    tdd_rationale: "new behavior",
    steps_json: JSON.stringify([
      { order: 1, description: "Write the failing test" },
      { order: 2, description: "Implement the limiter" },
    ]),
    proposed_commands_json: JSON.stringify([
      { pattern: "pnpm vitest run", why: "tests", category: "test" },
    ]),
    proposed_domains_json: JSON.stringify([{ domain: "registry.npmjs.org", why: "install" }]),
    risks_json: JSON.stringify(["might slow the hot path"]),
    files_json: JSON.stringify(["src/api/limiter.ts"]),
    raw_output_json: JSON.stringify({ summary: "Add a rate limiter" }),
    status: "pending",
    approved_at: null,
    approval_note: null,
    source: "planner",
    edit_note: null,
    supersedes_plan_id: null,
    ...overrides,
  };
}

function unwrap(result: ReturnType<typeof applyPlanEdits>) {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  return result;
}

describe("applyPlanEdits", () => {
  it("reports no change when nothing was touched", () => {
    const result = unwrap(applyPlanEdits(basePlan(), {}));
    // Approving a plan you agree with shouldn't leave a pointless v2 behind.
    expect(result.changed).toBe(false);
    expect(result.value.summary).toBe("Add a rate limiter");
    expect(result.value.steps).toHaveLength(2);
  });

  it("inherits every field the edit didn't mention", () => {
    const result = unwrap(applyPlanEdits(basePlan(), { summary: "Add a token-bucket rate limiter" }));
    expect(result.changed).toBe(true);
    expect(result.value.summary).toBe("Add a token-bucket rate limiter");
    expect(result.value.steps.map((s) => s.description)).toEqual([
      "Write the failing test",
      "Implement the limiter",
    ]);
    expect(result.value.risks).toEqual(["might slow the hot path"]);
    expect(result.value.proposedCommands[0]?.pattern).toBe("pnpm vitest run");
  });

  it("renumbers steps from their array order, so reordering can't duplicate a number", () => {
    const result = unwrap(
      applyPlanEdits(basePlan(), {
        steps: ["Implement the limiter", "Write the failing test", "Wire it into the router"],
      })
    );
    expect(result.value.steps).toEqual([
      { order: 1, description: "Implement the limiter" },
      { order: 2, description: "Write the failing test" },
      { order: 3, description: "Wire it into the router" },
    ]);
  });

  it("drops blank rows left behind by the editor", () => {
    const result = unwrap(
      applyPlanEdits(basePlan(), {
        steps: ["Keep this", "   ", ""],
        risks: ["", "real risk"],
        files: ["  src/a.ts  ", ""],
        proposedCommands: [{ pattern: "" }, { pattern: " pnpm test " }],
        proposedDomains: [{ domain: "" }, { domain: "example.com" }],
      })
    );
    expect(result.value.steps).toEqual([{ order: 1, description: "Keep this" }]);
    expect(result.value.risks).toEqual(["real risk"]);
    expect(result.value.files).toEqual(["src/a.ts"]);
    expect(result.value.proposedCommands.map((c) => c.pattern)).toEqual(["pnpm test"]);
    expect(result.value.proposedDomains.map((d) => d.domain)).toEqual(["example.com"]);
  });

  it("refuses a plan with no steps left", () => {
    const result = applyPlanEdits(basePlan(), { steps: ["", "  "] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one step/i);
  });

  it("refuses an empty summary", () => {
    const result = applyPlanEdits(basePlan(), { summary: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/summary/i);
  });

  it("notices a change in any editable field", () => {
    const cases: Parameters<typeof applyPlanEdits>[1][] = [
      { summary: "different" },
      { taskCategory: "bugfix" },
      { tddApplies: false },
      { tddRationale: "docs only" },
      { steps: ["Write the failing test", "Implement the limiter", "and one more"] },
      { steps: ["Implement the limiter", "Write the failing test"] }, // reorder only
      { risks: [] },
      { files: ["src/other.ts"] },
      { proposedCommands: [{ pattern: "pnpm vitest run", category: "different" }] },
      { proposedDomains: [] },
    ];
    for (const edit of cases) {
      expect(unwrap(applyPlanEdits(basePlan(), edit)).changed, JSON.stringify(edit)).toBe(true);
    }
  });

  it("doesn't count whitespace-only differences as changes", () => {
    const result = unwrap(
      applyPlanEdits(basePlan(), {
        summary: "  Add a rate limiter  ",
        steps: ["Write the failing test ", " Implement the limiter"],
      })
    );
    expect(result.changed).toBe(false);
  });

  it("keeps a note only when one was written", () => {
    expect(unwrap(applyPlanEdits(basePlan(), { note: "  " })).value.note).toBeUndefined();
    expect(unwrap(applyPlanEdits(basePlan(), { note: " use the helper " })).value.note).toBe(
      "use the helper"
    );
  });
});
