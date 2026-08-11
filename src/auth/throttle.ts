export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the caller may try again — only set when `allowed` is false. */
  retryAfterSec?: number;
}

export interface LoginThrottleOptions {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  /** Injectable clock, so tests don't have to sleep through a lockout. */
  now?: () => number;
}

interface Bucket {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * In-memory failed-login throttle, keyed independently by client IP and by
 * submitted username: an attacker spraying one password across many
 * usernames is limited by their IP, and a distributed attack on one account
 * is limited by that account's key.
 *
 * Deliberately not persisted. The state is cheap to rebuild, a restart of
 * this single-process server is not something an attacker can trigger, and
 * keeping it out of SQLite means a login flood can't grow the database.
 */
export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly options: LoginThrottleOptions;

  constructor(options: LoginThrottleOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  check(keys: string[]): ThrottleDecision {
    const now = this.now();
    let worst = 0;
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (bucket && bucket.lockedUntil > now) {
        worst = Math.max(worst, bucket.lockedUntil - now);
      }
    }
    if (worst > 0) return { allowed: false, retryAfterSec: Math.ceil(worst / 1000) };
    return { allowed: true };
  }

  recordFailure(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket || now - bucket.windowStart > this.options.windowMs) {
        this.buckets.set(key, { failures: 1, windowStart: now, lockedUntil: 0 });
        continue;
      }
      bucket.failures += 1;
      if (bucket.failures >= this.options.maxFailures) {
        bucket.lockedUntil = now + this.options.lockoutMs;
        bucket.failures = 0;
        bucket.windowStart = now;
      }
    }
    this.prune(now);
  }

  /** Called on a successful login: a legitimate user shouldn't stay penalized for earlier typos. */
  recordSuccess(keys: string[]): void {
    for (const key of keys) this.buckets.delete(key);
  }

  private prune(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lockedUntil <= now && now - bucket.windowStart > this.options.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
