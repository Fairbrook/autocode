/**
 * Env handed to `query()`. The SDK docs state `env` REPLACES the subprocess
 * environment when set — so this isn't just "strip a few vars", it's the
 * complete environment the nested Claude Code CLI process gets. Strip the
 * CLAUDE_CODE_-prefixed and CLAUDECODE session markers (so a nested CLI invoked from
 * inside a Claude Code session, e.g. during local dev of this harness,
 * doesn't mis-detect its context) and any stray API-key env vars (auth
 * must come from the OAuth credential store only — see docs/SANDBOX-FINDINGS.md
 * and the Gate 1 auth spike, both confirmed apiKeySource: "none").
 */
export function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("CLAUDE_CODE_")) continue;
    if (key === "CLAUDECODE") continue;
    if (key === "CLAUDE_PID") continue;
    if (key === "CLAUDE_EFFORT") continue;
    if (key === "ANTHROPIC_API_KEY") continue;
    if (key === "ANTHROPIC_AUTH_TOKEN") continue;
    env[key] = value;
  }
  return env;
}
