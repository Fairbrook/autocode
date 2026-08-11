import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hand-rolled rather than `promisify(scrypt)`: promisify resolves to the
 * three-argument overload and drops the options parameter, which is where
 * the cost parameters live.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * scrypt parameters. N=2^15 with r=8 costs ~32MB and ~100ms per hash on a
 * modern desktop — enough that an offline attack on a leaked hash is
 * expensive, cheap enough that a login doesn't feel slow. `maxmem` has to be
 * raised explicitly: Node's 32MB default is exactly at the 128*N*r boundary
 * and the call fails without headroom.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const MAX_MEM = 128 * N * R * 2;

/** Minimum length enforced when a password is set. Long over clever: this is a single-user-ish service with no password reset. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Hashes a password into a self-describing string:
 * `scrypt$N=32768,r=8,p=1$<salt-b64>$<hash-b64>`. Carrying the parameters
 * means the cost can be raised later without invalidating stored passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LEN, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Constant-time password check. Returns false (never throws) for malformed
 * or unparseable stored hashes, so a corrupt row can't crash a login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(password.normalize("NFKC"), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: Math.max(MAX_MEM, 128 * parsed.N * parsed.r * 2),
    });
  } catch {
    return false;
  }
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return null;
  const params = Object.fromEntries(
    (parts[1] ?? "").split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k ?? "", Number(v)];
    })
  );
  const N_ = params["N"];
  const r_ = params["r"];
  const p_ = params["p"];
  if (!Number.isFinite(N_) || !Number.isFinite(r_) || !Number.isFinite(p_)) return null;
  try {
    return {
      N: N_ as number,
      r: r_ as number,
      p: p_ as number,
      salt: Buffer.from(parts[2] ?? "", "base64"),
      hash: Buffer.from(parts[3] ?? "", "base64"),
    };
  } catch {
    return null;
  }
}

/**
 * A real hash of a random throwaway password, verified against when the
 * submitted username doesn't exist. Without it, unknown usernames would
 * return in ~0ms while known ones take ~100ms — a timing oracle that hands
 * an attacker the valid username list for free.
 */
let dummyHashPromise: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHashPromise;
}

/** Generates a strong random password (create-user's `--generate`). */
export function generatePassword(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}
