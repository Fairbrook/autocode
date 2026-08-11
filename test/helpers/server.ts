import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes an isolated autocode config: its own dataDir/worktreeRoot, every
 * notification channel off, and no live-agent budget worth spending. Auth
 * settings are left at their schema defaults so tests exercise the same
 * cookie policy production gets.
 */
export function writeTestConfig(
  dir: string,
  overrides: Record<string, unknown> = {}
): { configPath: string; projectsPath: string } {
  const configPath = path.join(dir, "autocode.json");
  const projectsPath = path.join(dir, "projects.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      // Never listened on — every request goes through app.inject().
      port: 4699,
      host: "127.0.0.1",
      dataDir: path.join(dir, "data"),
      worktreeRoot: path.join(dir, "worktrees"),
      models: { planner: "opus", implementer: "sonnet" },
      budgets: {
        plannerMaxTurns: 5,
        plannerMaxBudgetUsd: 1,
        implementerMaxTurns: 5,
        implementerMaxBudgetUsd: 1,
      },
      approvals: { pendingTimeoutMs: 60000 },
      setup: { defaultCommand: null, timeoutMs: 30000 },
      notify: { desktop: false, sse: true, webPush: false },
      ...overrides,
    })
  );
  writeFileSync(projectsPath, "[]");
  return { configPath, projectsPath };
}
