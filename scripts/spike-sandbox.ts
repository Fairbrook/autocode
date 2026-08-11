// Gate 2 spike: verify the Agent SDK's bubblewrap-backed sandbox actually
// enforces network and filesystem restrictions, and that failIfUnavailable
// fails closed rather than silently degrading. Not a unit test — a
// human-readable pass/fail report run once during setup verification.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createServer } from "node:http";
import { mkdirSync, existsSync, rmSync } from "node:fs";

function scrubbedEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT") {
      delete env[key];
    }
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

async function runSandboxedBash(command: string, port: number): Promise<{ ok: boolean; text: string }> {
  let lastText = "";
  let sawResult = false;
  let resultIsError = false;
  try {
    for await (const message of query({
      prompt: `Run this exact bash command and report ONLY its raw stdout/stderr, nothing else: ${command}`,
      options: {
        model: "sonnet",
        maxTurns: 3,
        tools: ["Bash"],
        permissionMode: "bypassPermissions", // spike only — no filter engine exists yet
        env: scrubbedEnv(),
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          network: {
            allowLocalBinding: true,
            allowedDomains: [], // deliberately empty — nothing external should work
            strictAllowlist: true,
          },
          filesystem: {
            allowWrite: [ALLOWED_DIR],
          },
        },
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") lastText += block.text;
        }
      }
      if (message.type === "result") {
        sawResult = true;
        resultIsError = message.subtype !== "success";
        if (resultIsError) lastText += ` [[result subtype: ${message.subtype}]]`;
      }
    }
  } catch (err) {
    return { ok: false, text: `THREW: ${(err as Error).message}` };
  }
  return { ok: sawResult && !resultIsError, text: lastText.trim() };
}

const ALLOWED_DIR = "/tmp/autocode-sandbox-spike-allowed";

async function main() {
  console.log("=== Gate 2: sandbox spike ===\n");

  // The sandbox can only bind-mount directories that already exist on the
  // host — the harness must create worktree/scratch dirs before invoking
  // query(), same as the real orchestration flow does.
  rmSync(ALLOWED_DIR, { recursive: true, force: true });
  mkdirSync(ALLOWED_DIR, { recursive: true });
  console.log(`Pre-created host-side allowed dir: ${ALLOWED_DIR} (exists=${existsSync(ALLOWED_DIR)})`);

  // Start a real minimal HTTP listener on loopback the sandboxed agent should be able to reach.
  const port = 58080;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("loopback-ok\n");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Local test HTTP listener up on 127.0.0.1:${port}`);

  const checks: Array<{ name: string; command: string; expectSuccessText?: string; expectFailure?: boolean }> = [
    {
      name: "loopback curl (should SUCCEED and see loopback-ok)",
      command: `curl -m 5 -s http://127.0.0.1:${port}`,
      expectSuccessText: "loopback-ok",
    },
    {
      name: "external curl (should FAIL to connect)",
      command: `curl -m 5 -s -o /dev/null -w '%{http_code}' https://example.com || echo CURL_FAILED`,
      expectFailure: true,
    },
    {
      name: "write inside pre-created allowed dir (should SUCCEED)",
      command: `echo hi > ${ALLOWED_DIR}/f.txt && cat ${ALLOWED_DIR}/f.txt`,
      expectSuccessText: "hi",
    },
    {
      name: "write outside allowed dir (should FAIL)",
      command: `echo pwned > /tmp/autocode-sandbox-spike-DISALLOWED.txt || echo WRITE_FAILED`,
      expectFailure: true,
    },
  ];

  for (const check of checks) {
    process.stdout.write(`\n--- ${check.name} ---\n`);
    const { ok, text } = await runSandboxedBash(check.command, port);
    console.log(`agent turn completed=${ok}`);
    console.log(`output: ${text.slice(0, 400)}`);
  }

  server.close();
  console.log("\n=== Done. Compare each output against its expectation above. ===");
  console.log("Also manually verify failIfUnavailable by temporarily hiding bwrap from PATH and re-running.");
}

main().catch((err) => {
  console.error("SPIKE FAILED TO RUN:", err);
  process.exit(1);
});
