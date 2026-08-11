// One-off live smoke test for the planner path (not part of the vitest
// suite — costs real usage and needs network). Run manually:
//   node scripts/spike-planner.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.ts";
import { createProject } from "../src/db/repo/projects.ts";
import { createTask } from "../src/db/repo/tasks.ts";
import { runPlanner } from "../src/agent/planner.ts";

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "autocode-planner-spike-"));
  const db = openDb(path.join(dir, "spike.db"));

  const repoPath = path.join(process.env.HOME ?? "", ".local/share/autocode/test-repo");
  const project = createProject(db, { name: "test-repo", repoPath });
  const task = createTask(db, {
    projectId: project.id,
    title: "Add a subtract function",
    description: "Add a subtract(a, b) function to src/add.js's module (or a new src/subtract.js file), with tests.",
  });

  console.log("Running planner against", repoPath);
  const outcome = await runPlanner({
    db,
    task,
    project,
    model: "opus",
    maxTurns: 20,
    maxBudgetUsd: 2,
  });

  console.log("ok:", outcome.ok);
  if (!outcome.ok) {
    console.log("error:", outcome.errorSummary);
    process.exit(1);
  }
  console.log(JSON.stringify(outcome.plan, null, 2));
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
