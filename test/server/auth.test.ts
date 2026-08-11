import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../src/server/index.ts";
import type { Db } from "../../src/db/index.ts";
import { createUser, getUserByUsername, setUserDisabled, setUserPassword } from "../../src/db/repo/users.ts";
import {
  createSession,
  deleteSessionsForUser,
  listSessionsForUser,
} from "../../src/db/repo/sessions.ts";
import { hashPassword } from "../../src/auth/passwords.ts";
import { hashSessionToken } from "../../src/auth/sessions.ts";
import { writeTestConfig } from "../helpers/server.ts";
import { loginAs, TEST_PASSWORD, TEST_USERNAME } from "../helpers/auth.ts";

let base: string;
let server: Awaited<ReturnType<typeof buildServer>>;
let db: Db;

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "autocode-auth-test-"));
  const { configPath, projectsPath } = writeTestConfig(base);
  server = await buildServer({ configPath, projectsPath });
  db = server.db;
});

afterEach(async () => {
  await server.app.close();
  rmSync(base, { recursive: true, force: true });
});

const app = () => server.app;

describe("the guard", () => {
  it("refuses every API route without a session", async () => {
    for (const url of ["/api/tasks", "/api/projects", "/api/metrics", "/api/worktrees", "/api/approvals"]) {
      const res = await app().inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toMatch(/authentication required/i);
    }
  });

  it("refuses the SSE stream without a session", async () => {
    // EventSource can't send an Authorization header, which is exactly why
    // the session lives in a cookie — but it must still be enforced here.
    const res = await app().inject({ method: "GET", url: "/api/runs/1/events" });
    expect(res.statusCode).toBe(401);
  });

  it("bounces browser navigation to the login page", async () => {
    for (const url of ["/", "/index.html", "/app.js"]) {
      const res = await app().inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe("/login.html");
    }
  });

  it("serves only the login page's own assets anonymously", async () => {
    for (const url of ["/login.html", "/login.js", "/styles.css"]) {
      const res = await app().inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("has no signup route to abuse", async () => {
    const signupish = ["/api/auth/signup", "/api/auth/register", "/api/users"];

    // Anonymously they're indistinguishable from anything else — the guard
    // answers before routing does, so the 401 doesn't even reveal which
    // routes exist.
    for (const url of signupish) {
      const res = await app().inject({ method: "POST", url, payload: { username: "x", password: "y" } });
      expect(res.statusCode, url).toBe(401);
    }

    // And they genuinely don't exist: even a logged-in user can't mint an
    // account over HTTP. scripts/create-user.ts is the only way in.
    const { headers } = await loginAs(app(), db);
    for (const url of signupish) {
      const res = await app().inject({ method: "POST", url, headers, payload: { username: "x", password: "y" } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it("rejects a forged or unknown session cookie", async () => {
    for (const cookie of [
      "autocode_session=not-a-real-token",
      "autocode_session=",
      "autocode_session=" + "a".repeat(43),
    ]) {
      const res = await app().inject({ method: "GET", url: "/api/tasks", headers: { cookie } });
      expect(res.statusCode, cookie).toBe(401);
    }
  });
});

describe("login", () => {
  it("accepts the right password and issues a hardened cookie", async () => {
    createUser(db, { username: TEST_USERNAME, passwordHash: await hashPassword(TEST_PASSWORD) });

    const res = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { username: TEST_USERNAME } });

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("autocode_session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\//i);
    // The raw token must never be what's stored.
    const token = setCookie.split("autocode_session=")[1]?.split(";")[0] ?? "";
    expect(token.length).toBeGreaterThan(30);
    const user = getUserByUsername(db, TEST_USERNAME)!;
    const stored = listSessionsForUser(db, user.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).toBe(hashSessionToken(token));
    expect(stored[0]?.token_hash).not.toBe(token);
  });

  it("is case-insensitive on the username", async () => {
    createUser(db, { username: TEST_USERNAME, passwordHash: await hashPassword(TEST_PASSWORD) });
    const res = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "TeStEr", password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it("gives one indistinguishable error for wrong password and unknown user", async () => {
    createUser(db, { username: TEST_USERNAME, passwordHash: await hashPassword(TEST_PASSWORD) });

    const wrongPassword = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: TEST_USERNAME, password: "not-the-password" },
    });
    const unknownUser = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ghost", password: TEST_PASSWORD },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    // Identical body: nothing here enumerates which usernames exist.
    expect(wrongPassword.json()).toEqual(unknownUser.json());
    expect(wrongPassword.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a disabled account", async () => {
    const user = createUser(db, {
      username: TEST_USERNAME,
      passwordHash: await hashPassword(TEST_PASSWORD),
    });
    setUserDisabled(db, user.id, true);

    const res = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("locks out after repeated failures and reports Retry-After", async () => {
    createUser(db, { username: TEST_USERNAME, passwordHash: await hashPassword(TEST_PASSWORD) });

    let last = await app().inject({ method: "POST", url: "/api/auth/login", payload: {} });
    for (let i = 0; i < 12; i++) {
      last = await app().inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: TEST_USERNAME, password: `guess-${i}` },
      });
      if (last.statusCode === 429) break;
    }
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);

    // The lockout holds even once the attacker stumbles onto the right password.
    const withCorrect = await app().inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(withCorrect.statusCode).toBe(429);
  }, 30_000);
});

describe("an authenticated session", () => {
  it("reaches the API, the UI and the current user", async () => {
    const { headers } = await loginAs(app(), db);

    const tasks = await app().inject({ method: "GET", url: "/api/tasks", headers });
    expect(tasks.statusCode).toBe(200);

    const page = await app().inject({ method: "GET", url: "/", headers });
    expect(page.statusCode).toBe(200);

    const me = await app().inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.json()).toEqual({ username: TEST_USERNAME });
  });

  it("dies on logout", async () => {
    const { headers } = await loginAs(app(), db);

    const out = await app().inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(out.statusCode).toBe(200);

    const after = await app().inject({ method: "GET", url: "/api/tasks", headers });
    expect(after.statusCode).toBe(401);
    expect(listSessionsForUser(db, getUserByUsername(db, TEST_USERNAME)!.id)).toHaveLength(0);
  });

  it("dies the moment the account is disabled", async () => {
    const { headers } = await loginAs(app(), db);
    const user = getUserByUsername(db, TEST_USERNAME)!;

    // The user row is re-read per request, so this takes effect immediately
    // rather than at the end of the cookie's 30-day life.
    setUserDisabled(db, user.id, true);
    const after = await app().inject({ method: "GET", url: "/api/tasks", headers });
    expect(after.statusCode).toBe(401);
  });

  it("dies when the password is changed the way create-user --reset does", async () => {
    const { headers } = await loginAs(app(), db);
    const user = getUserByUsername(db, TEST_USERNAME)!;

    setUserPassword(db, user.id, await hashPassword("a-brand-new-password"));
    deleteSessionsForUser(db, user.id);

    const after = await app().inject({ method: "GET", url: "/api/tasks", headers });
    expect(after.statusCode).toBe(401);
  });

  it("expires", async () => {
    const user = createUser(db, {
      username: TEST_USERNAME,
      passwordHash: await hashPassword(TEST_PASSWORD),
    });
    createSession(db, {
      tokenHash: hashSessionToken("expired-token"),
      userId: user.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await app().inject({
      method: "GET",
      url: "/api/tasks",
      headers: { cookie: "autocode_session=expired-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * The deployed topology: nginx terminates TLS on another host in the same
 * ZeroTier network and proxies over the VPN to this app, which is bound to
 * its ZeroTier address and speaks plain HTTP. Everything security-relevant
 * here depends on the forwarding headers, so it gets its own server.
 */
describe("behind a reverse proxy on the VPN", () => {
  let proxiedBase: string;
  let proxied: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    proxiedBase = mkdtempSync(path.join(tmpdir(), "autocode-proxy-test-"));
    const { configPath, projectsPath } = writeTestConfig(proxiedBase, {
      // app.inject() presents as 127.0.0.1, standing in for the proxy's
      // ZeroTier address.
      trustProxy: "127.0.0.1",
      auth: { cookieSecure: "auto", trustedOrigins: ["https://autocode.example.com"] },
    });
    proxied = await buildServer({ configPath, projectsPath });
  });

  afterEach(async () => {
    await proxied.app.close();
    rmSync(proxiedBase, { recursive: true, force: true });
  });

  const proxyHeaders = {
    "x-forwarded-proto": "https",
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-host": "autocode.example.com",
  };

  it("marks the cookie Secure when nginx reports the request came in over TLS", async () => {
    createUser(proxied.db, {
      username: TEST_USERNAME,
      passwordHash: await hashPassword(TEST_PASSWORD),
    });

    const res = await proxied.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: proxyHeaders,
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/Secure/i);
  });

  it("leaves the cookie non-Secure for a direct plain-HTTP hit over the VPN", async () => {
    createUser(proxied.db, {
      username: TEST_USERNAME,
      passwordHash: await hashPassword(TEST_PASSWORD),
    });

    // Reaching the app directly on its ZeroTier address, bypassing nginx. A
    // hard `cookieSecure: true` would hand the browser a cookie it then
    // refuses to send back, and login would appear to silently fail.
    const res = await proxied.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).not.toMatch(/Secure/i);
  });

  it("throttles the real client, not the proxy", async () => {
    createUser(proxied.db, {
      username: TEST_USERNAME,
      passwordHash: await hashPassword(TEST_PASSWORD),
    });

    // One client burns the per-IP budget...
    for (let i = 0; i < 12; i++) {
      await proxied.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { ...proxyHeaders, "x-forwarded-for": "203.0.113.7" },
        payload: { username: "someone-else", password: `guess-${i}` },
      });
    }
    const attacker = await proxied.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { ...proxyHeaders, "x-forwarded-for": "203.0.113.7" },
      payload: { username: "someone-else", password: "again" },
    });
    expect(attacker.statusCode).toBe(429);

    // ...without locking out everyone else arriving through the same proxy.
    const bystander = await proxied.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { ...proxyHeaders, "x-forwarded-for": "198.51.100.4" },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    expect(bystander.statusCode).toBe(200);
  }, 30_000);

  it("accepts writes from the public origin the browser actually sees", async () => {
    const { cookie } = await loginAs(proxied.app, proxied.db);

    const res = await proxied.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        ...proxyHeaders,
        cookie,
        origin: "https://autocode.example.com",
        // nginx's default Host is the upstream address — the case that
        // would 403 every write without the forwarded host / trustedOrigins.
        host: "10.242.236.182:4600",
      },
      payload: { name: "legit", repoPath: "/tmp/legit" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("still rejects a foreign origin arriving through the proxy", async () => {
    const { cookie } = await loginAs(proxied.app, proxied.db);

    const res = await proxied.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...proxyHeaders, cookie, origin: "https://evil.example.com" },
      payload: { name: "pwned", repoPath: "/tmp/pwned" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("cross-site protection", () => {
  it("rejects a state-changing request carrying a foreign Origin", async () => {
    const { cookie } = await loginAs(app(), db);

    const res = await app().inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie, origin: "https://evil.example.com", host: "autocode.example.com" },
      payload: { name: "pwned", repoPath: "/tmp/pwned" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows a same-origin request", async () => {
    const { cookie } = await loginAs(app(), db);

    const res = await app().inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie,
        origin: "https://autocode.example.com",
        host: "autocode.example.com",
      },
      payload: { name: "legit", repoPath: "/tmp/legit" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("still lets a non-browser client through (no Origin to check)", async () => {
    const { cookie } = await loginAs(app(), db);
    const res = await app().inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "scripted", repoPath: "/tmp/scripted" },
    });
    expect(res.statusCode).toBe(201);
  });
});
