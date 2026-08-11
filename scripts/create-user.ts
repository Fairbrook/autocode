// Account management for autocode. Accounts exist only here — the HTTP
// surface has no signup and no password-reset route, by design: an instance
// of this harness can run arbitrary code on the host, so the ability to
// mint a login stays on the box.
//
//   pnpm create-user <username>              create a user (prompts for a password)
//   pnpm create-user <username> --generate   create with a generated password, printed once
//   pnpm create-user <username> --reset      change an existing user's password
//   pnpm create-user --list                  list accounts
//   pnpm create-user <username> --disable    disable an account (kills its sessions)
//   pnpm create-user <username> --enable     re-enable an account
//
// Non-interactive: set AUTOCODE_PASSWORD instead of being prompted.
// Alternate deployment: --config <path/to/autocode.json>.
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import {
  createUser,
  getUserByUsername,
  listUsers,
  normalizeUsername,
  setUserDisabled,
  setUserPassword,
} from "../src/db/repo/users.ts";
import { deleteSessionsForUser } from "../src/db/repo/sessions.ts";
import { generatePassword, hashPassword, MIN_PASSWORD_LENGTH } from "../src/auth/passwords.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const flags = new Set<string>();
const positional: string[] = [];
/** Alternate config file, for a second deployment or a throwaway instance. */
let configPathArg: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;
  if (arg === "--config") {
    configPathArg = args[++i];
  } else if (arg.startsWith("--config=")) {
    configPathArg = arg.slice("--config=".length);
  } else if (arg.startsWith("--")) {
    flags.add(arg);
  } else {
    positional.push(arg);
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Reads a line with terminal echo suppressed. readline exposes no supported
 * way to do this, so the standard approach is to intercept its output
 * writer — keystrokes are still consumed, just never echoed.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const internals = rl as unknown as {
      _writeToOutput: (text: string) => void;
      output: NodeJS.WritableStream;
    };
    let muted = false;
    internals._writeToOutput = (text: string) => {
      if (!muted) internals.output.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function promptVisible(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function readNewPassword(): Promise<string> {
  const fromEnv = process.env.AUTOCODE_PASSWORD;
  if (fromEnv) {
    if (fromEnv.length < MIN_PASSWORD_LENGTH) {
      fail(`AUTOCODE_PASSWORD is shorter than the ${MIN_PASSWORD_LENGTH}-character minimum`);
    }
    return fromEnv;
  }
  if (!process.stdin.isTTY) {
    fail("no TTY to prompt on — set AUTOCODE_PASSWORD, or pass --generate");
  }

  for (;;) {
    const first = await promptHidden("Password: ");
    if (first.length < MIN_PASSWORD_LENGTH) {
      console.error(`  too short — ${MIN_PASSWORD_LENGTH} characters minimum. Try again.\n`);
      continue;
    }
    const second = await promptHidden("Confirm password: ");
    if (first !== second) {
      console.error("  passwords didn't match. Try again.\n");
      continue;
    }
    return first;
  }
}

async function main(): Promise<void> {
  const config = loadConfig(configPathArg ?? path.join(REPO_ROOT, "config", "autocode.json"));
  const db = openDb(config.dbPath);

  if (flags.has("--list")) {
    const users = listUsers(db);
    if (users.length === 0) {
      console.log("No accounts yet. Create one with: pnpm create-user <username>");
      return;
    }
    console.log("username             disabled  last login");
    for (const u of users) {
      console.log(
        `${u.username.padEnd(20)} ${String(Boolean(u.disabled)).padEnd(9)} ${u.last_login_at ?? "never"}`
      );
    }
    return;
  }

  const rawUsername = positional[0] ?? (await promptVisible("Username: "));
  const username = normalizeUsername(rawUsername);
  if (!username) fail("a username is required");
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    fail("username must be 2-32 chars of a-z, 0-9, dot, underscore or hyphen");
  }

  const existing = getUserByUsername(db, username);

  if (flags.has("--disable") || flags.has("--enable")) {
    if (!existing) fail(`no such user: ${username}`);
    const disable = flags.has("--disable");
    setUserDisabled(db, existing.id, disable);
    const killed = disable ? deleteSessionsForUser(db, existing.id) : 0;
    console.log(
      disable
        ? `Disabled ${username} and revoked ${killed} active session(s).`
        : `Enabled ${username}.`
    );
    return;
  }

  const resetting = flags.has("--reset");
  if (existing && !resetting) {
    fail(`user ${username} already exists — use --reset to change their password`);
  }
  if (!existing && resetting) {
    fail(`no such user: ${username}`);
  }

  let password: string;
  let generated = false;
  if (flags.has("--generate")) {
    password = generatePassword();
    generated = true;
  } else {
    password = await readNewPassword();
  }

  const passwordHash = await hashPassword(password);

  if (existing) {
    setUserPassword(db, existing.id, passwordHash);
    // A password change must not leave old logins alive — that's most of
    // the point of changing it.
    const killed = deleteSessionsForUser(db, existing.id);
    console.log(`Password updated for ${username}; revoked ${killed} active session(s).`);
  } else {
    createUser(db, { username, passwordHash });
    console.log(`Created user ${username}.`);
  }

  if (generated) {
    console.log(`\n  Generated password: ${password}\n`);
    console.log("  Store it now — it is not recoverable, only replaceable with --reset.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
