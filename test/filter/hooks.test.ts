import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { createFilterPreToolUseHook } from "../../src/filter/hooks.ts";
import { loadShippedRules } from "../../src/filter/rules.ts";
import type { Rule } from "../../src/filter/types.ts";

const RULES_DIR = path.join(process.cwd(), "config", "rules");
let shippedRules: Rule[];
let worktree: string;

beforeAll(() => {
  shippedRules = loadShippedRules(RULES_DIR);
  worktree = path.join(mkdtempSync(path.join(tmpdir(), "autocode-hooks-test-")), "worktree");
  mkdirSync(worktree, { recursive: true });
});

interface HookDeps {
  localServiceHosts?: string[];
  unsandboxed?: boolean;
}

async function run(command: string, deps: HookDeps = {}) {
  const hook = createFilterPreToolUseHook({
    getRules: () => shippedRules,
    getWriteRoots: () => [worktree],
    getDenyWriteRoots: () => [],
    getAllowedDomains: () => ["registry.npmjs.org"],
    getLocalServiceHosts: () => deps.localServiceHosts ?? [],
    getUnsandboxedCommandsAllowed: () => deps.unsandboxed ?? false,
    onDecision: () => {},
  });
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  } as unknown as HookInput;
  const output = await hook(input, "toolu_test", { signal: new AbortController().signal });
  return (output as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};
}

describe("createFilterPreToolUseHook — sandbox escape hatch", () => {
  it("does not inject dangerouslyDisableSandbox when the project has not opted in", async () => {
    // The SDK ignores the flag unless allowUnsandboxedCommands is set, so
    // injecting it here would claim in the audit trail that a command ran
    // unsandboxed when it did not. This is the bug documented in
    // docs/SANDBOX-FINDINGS.md, now enforced.
    const out = await run("pnpm test");
    expect(out.permissionDecision).toBe("allow");
    expect(out.updatedInput).toBeUndefined();
  });

  it("injects it for a sandboxOverride rule once the project opts in", async () => {
    const out = await run("pnpm test", { unsandboxed: true });
    expect(out.permissionDecision).toBe("allow");
    expect((out.updatedInput as Record<string, unknown>).dangerouslyDisableSandbox).toBe(true);
  });

  it("leaves non-sandboxOverride commands sandboxed even when the project opts in", async () => {
    const out = await run("git status", { unsandboxed: true });
    expect(out.permissionDecision).toBe("allow");
    expect(out.updatedInput).toBeUndefined();
  });
});

describe("createFilterPreToolUseHook — local service proxy routing", () => {
  it("prefixes allowed commands with the narrowed NO_PROXY", async () => {
    const out = await run("git status", { localServiceHosts: ["127.0.0.1"] });
    expect(out.permissionDecision).toBe("allow");
    const command = (out.updatedInput as Record<string, unknown>).command as string;
    expect(command).toMatch(/^export NO_PROXY='[^']*' no_proxy='[^']*' NODE_USE_ENV_PROXY=1; git status$/);
    expect(command).not.toContain("127.0.0.1");
  });

  it("skips the prefix when the command is being unsandboxed anyway", async () => {
    // Outside the sandbox there is no proxy to route to; the command reaches
    // the host's services natively.
    const out = await run("pnpm test", { localServiceHosts: ["127.0.0.1"], unsandboxed: true });
    const updated = out.updatedInput as Record<string, unknown>;
    expect(updated.dangerouslyDisableSandbox).toBe(true);
    expect(updated.command).toBe("pnpm test");
  });

  it("does not touch denied or asked calls", async () => {
    const denied = await run("cat /etc/shadow > /etc/passwd", { localServiceHosts: ["127.0.0.1"] });
    expect(denied.permissionDecision).toBe("deny");
    expect(denied.updatedInput).toBeUndefined();

    const asked = await run("some-unknown-binary --flag", { localServiceHosts: ["127.0.0.1"] });
    expect(asked.permissionDecision).toBe("ask");
    expect(asked.updatedInput).toBeUndefined();
  });
});
