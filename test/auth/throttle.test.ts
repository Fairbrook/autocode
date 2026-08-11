import { describe, expect, it } from "vitest";
import { LoginThrottle } from "../../src/auth/throttle.ts";

function makeThrottle() {
  let clock = 1_000_000;
  const throttle = new LoginThrottle({
    maxFailures: 3,
    windowMs: 60_000,
    lockoutMs: 60_000,
    now: () => clock,
  });
  return { throttle, advance: (ms: number) => (clock += ms) };
}

describe("login throttle", () => {
  it("locks a key out after the configured number of failures", () => {
    const { throttle } = makeThrottle();
    const keys = ["ip:1.2.3.4", "user:kevin"];

    expect(throttle.check(keys).allowed).toBe(true);
    throttle.recordFailure(keys);
    throttle.recordFailure(keys);
    expect(throttle.check(keys).allowed).toBe(true);

    throttle.recordFailure(keys);
    const decision = throttle.check(keys);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
  });

  it("releases the lockout once it expires", () => {
    const { throttle, advance } = makeThrottle();
    const keys = ["ip:1.2.3.4"];
    for (let i = 0; i < 3; i++) throttle.recordFailure(keys);
    expect(throttle.check(keys).allowed).toBe(false);

    advance(60_001);
    expect(throttle.check(keys).allowed).toBe(true);
  });

  it("keeps keys independent, so one attacker can't lock everyone out", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 3; i++) throttle.recordFailure(["ip:9.9.9.9", "user:victim"]);

    // The attacker's IP and the sprayed username are locked...
    expect(throttle.check(["ip:9.9.9.9"]).allowed).toBe(false);
    expect(throttle.check(["user:victim"]).allowed).toBe(false);
    // ...but an unrelated user from a different address is unaffected.
    expect(throttle.check(["ip:1.1.1.1", "user:someone-else"]).allowed).toBe(true);
  });

  it("blocks when ANY of the request's keys is locked", () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < 3; i++) throttle.recordFailure(["user:victim"]);
    // Same account, fresh IP — a distributed attack on one account still hits the wall.
    expect(throttle.check(["ip:5.5.5.5", "user:victim"]).allowed).toBe(false);
  });

  it("forgets failures spread beyond the window", () => {
    const { throttle, advance } = makeThrottle();
    const keys = ["ip:1.2.3.4"];
    throttle.recordFailure(keys);
    throttle.recordFailure(keys);
    advance(60_001);
    throttle.recordFailure(keys);
    // The two old failures aged out, so this isn't the third strike.
    expect(throttle.check(keys).allowed).toBe(true);
  });

  it("clears the record on a successful login", () => {
    const { throttle } = makeThrottle();
    const keys = ["ip:1.2.3.4", "user:kevin"];
    throttle.recordFailure(keys);
    throttle.recordFailure(keys);
    throttle.recordSuccess(keys);
    throttle.recordFailure(keys);
    expect(throttle.check(keys).allowed).toBe(true);
  });
});
