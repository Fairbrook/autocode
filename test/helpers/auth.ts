import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db/index.ts";
import { createUser } from "../../src/db/repo/users.ts";
import { hashPassword } from "../../src/auth/passwords.ts";

export const TEST_USERNAME = "tester";
export const TEST_PASSWORD = "correct-horse-battery-staple";

/**
 * Creates an account and logs in, returning the headers to attach to
 * subsequent `app.inject()` calls. There is no auth bypass in the server —
 * every test drives the real login flow, which means the guard is exercised
 * by the whole suite rather than only by the auth tests.
 */
export async function loginAs(
  app: FastifyInstance,
  db: Db,
  username = TEST_USERNAME,
  password = TEST_PASSWORD
): Promise<{ cookie: string; headers: Record<string, string> }> {
  createUser(db, { username, passwordHash: await hashPassword(password) });

  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`test login failed: ${res.statusCode} ${res.body}`);
  }

  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error("login response carried no Set-Cookie header");
  const cookie = raw.split(";")[0] ?? "";
  return { cookie, headers: { cookie } };
}
