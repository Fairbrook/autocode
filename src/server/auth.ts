import fastifyCookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.ts";
import { deleteExpiredSessions, deleteSessionByTokenHash } from "../db/repo/sessions.ts";
import { getUserByUsername, markUserLogin } from "../db/repo/users.ts";
import { dummyHash, verifyPassword } from "../auth/passwords.ts";
import { hashSessionToken, resolveSession, startSession } from "../auth/sessions.ts";
import { LoginThrottle } from "../auth/throttle.ts";
import type { UserRow } from "../types.ts";
import type { Config } from "../config.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth guard for every request that got past it. */
    user?: UserRow;
  }
}

/**
 * Paths reachable without a session. Everything else — including every
 * static asset and the SSE stream — requires one.
 *
 * `/styles.css` is here because the login page uses it; it contains no
 * information worth protecting. Note there is no signup route to exempt:
 * accounts exist only via scripts/create-user.ts.
 */
const PUBLIC_PATHS = new Set([
  "/login.html",
  "/login.js",
  "/styles.css",
  "/favicon.ico",
  "/api/auth/login",
]);

const LOGIN_PAGE = "/login.html";

export interface RegisterAuthInput {
  app: FastifyInstance;
  db: Db;
  config: Config;
}

export async function registerAuth({ app, db, config }: RegisterAuthInput): Promise<void> {
  await app.register(fastifyCookie);

  deleteExpiredSessions(db);

  const ttlMs = config.auth.sessionTtlHours * 3_600_000;
  const throttle = new LoginThrottle({
    maxFailures: config.auth.maxFailedAttempts,
    windowMs: config.auth.lockoutMinutes * 60_000,
    lockoutMs: config.auth.lockoutMinutes * 60_000,
  });

  function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
    reply.setCookie(config.auth.cookieName, token, {
      httpOnly: true,
      // Strict (not Lax) is affordable here: nothing links into this app
      // from elsewhere, and it means no cross-site request — including a
      // top-level form POST — ever carries the session.
      sameSite: "strict",
      secure: resolveCookieSecure(config.auth.cookieSecure, req),
      path: "/",
      maxAge: Math.floor(ttlMs / 1000),
    });
  }

  function clearSessionCookie(req: FastifyRequest, reply: FastifyReply): void {
    reply.clearCookie(config.auth.cookieName, {
      httpOnly: true,
      sameSite: "strict",
      secure: resolveCookieSecure(config.auth.cookieSecure, req),
      path: "/",
    });
  }

  // ---- The guard. Registered before every route, so static files, the SSE
  // stream and the API are all covered by one rule. ----
  app.addHook("onRequest", async (req, reply) => {
    const pathOnly = req.url.split("?")[0] ?? "/";
    if (PUBLIC_PATHS.has(pathOnly)) return;

    const token = req.cookies[config.auth.cookieName];
    const resolved = resolveSession(db, token, ttlMs);
    if (!resolved) {
      if (pathOnly.startsWith("/api/")) {
        return reply.code(401).send({ error: "authentication required" });
      }
      // EventSource and fetch follow redirects, so an API-shaped client
      // never lands here; a browser navigating with a dead cookie does.
      return reply.redirect(LOGIN_PAGE, 302);
    }

    req.user = resolved.user;

    // CSRF defense-in-depth behind SameSite=Strict: a browser always sends
    // Origin on a cross-origin state-changing request, so a mismatch is a
    // forgery. A missing Origin means a non-browser client (curl, a script)
    // — those aren't subject to CSRF, since nothing else is driving them.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin !== undefined && !isAllowedOrigin(origin, req, config.auth.trustedOrigins)) {
        req.log.warn(
          { origin, host: req.host, hint: "if this is your own domain, add it to auth.trustedOrigins" },
          "rejected cross-origin write"
        );
        return reply.code(403).send({ error: "cross-origin request rejected" });
      }
    }
  });

  // ---- Routes ----
  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    async (req, reply) => {
      const username = String(req.body?.username ?? "").trim();
      const password = String(req.body?.password ?? "");

      const keys = [`ip:${req.ip}`, `user:${username.toLowerCase()}`];
      const decision = throttle.check(keys);
      if (!decision.allowed) {
        reply.header("Retry-After", String(decision.retryAfterSec ?? 60));
        return reply.code(429).send({
          error: `Too many failed attempts. Try again in ${decision.retryAfterSec ?? 60}s.`,
        });
      }

      const user = username ? getUserByUsername(db, username) : undefined;
      // Verify against a throwaway hash when the user doesn't exist (or is
      // disabled) so every outcome costs the same ~100ms — otherwise the
      // response time enumerates valid usernames.
      const storedHash = user && !user.disabled ? user.password_hash : await dummyHash();
      const passwordOk = await verifyPassword(password, storedHash);

      if (!user || user.disabled || !passwordOk) {
        throttle.recordFailure(keys);
        req.log.warn({ username, ip: req.ip }, "failed login");
        // One message for every failure mode: no "unknown user" vs "wrong
        // password" distinction to mine.
        return reply.code(401).send({ error: "Invalid username or password" });
      }

      throttle.recordSuccess(keys);
      deleteExpiredSessions(db);
      const { token } = startSession(db, {
        userId: user.id,
        ttlMs,
        userAgent: req.headers["user-agent"] ?? null,
        ip: req.ip,
      });
      markUserLogin(db, user.id);
      setSessionCookie(req, reply, token);
      req.log.info({ username: user.username, ip: req.ip }, "login");
      return { user: { username: user.username } };
    }
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[config.auth.cookieName];
    if (token) deleteSessionByTokenHash(db, hashSessionToken(token));
    clearSessionCookie(req, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({
    username: req.user?.username ?? null,
  }));
}

/**
 * Whether to mark this response's session cookie Secure.
 *
 * `"auto"` keys off how the request actually arrived, which is what makes a
 * plain-HTTP deployment inside a VPN work without permanently giving up the
 * flag: served over HTTPS the cookie is Secure, so a later downgrade to
 * http:// can't retrieve it; served over http:// it isn't, so the browser
 * will actually send it back. Note `req.protocol` only reports https behind
 * a TLS-terminating proxy when `trustProxy` is configured.
 */
export function resolveCookieSecure(
  setting: boolean | "auto",
  req: Pick<FastifyRequest, "protocol">
): boolean {
  if (setting !== "auto") return setting;
  return req.protocol === "https";
}

/**
 * True when the Origin header belongs to this app.
 *
 * Compares against `req.host`, which is the forwarded host when `trustProxy`
 * is configured — behind a reverse proxy the browser's Origin is the public
 * domain while the raw Host header is whatever the proxy sent upstream.
 * nginx's *default* is to send the upstream address as Host, which would
 * make every write look cross-origin; `auth.trustedOrigins` is the explicit
 * escape hatch for that, and for any other proxy that rewrites the host.
 */
export function isAllowedOrigin(
  origin: string,
  req: Pick<FastifyRequest, "host">,
  trustedOrigins: string[]
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === req.host) return true;
  return trustedOrigins.some((trusted) => {
    try {
      return new URL(trusted).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}
