import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generatePassword,
  MIN_PASSWORD_LENGTH,
} from "../../src/auth/passwords.ts";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("correct-horse-battery-stapl", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("Correct-Horse-Battery-Staple", hash)).toBe(false);
  });

  it("salts every hash, so identical passwords never collide on disk", async () => {
    const a = await hashPassword("the-same-password");
    const b = await hashPassword("the-same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("the-same-password", a)).toBe(true);
    expect(await verifyPassword("the-same-password", b)).toBe(true);
  });

  it("stores its own parameters, so the cost can be raised later", async () => {
    const hash = await hashPassword("some-password-here");
    expect(hash.startsWith("scrypt$N=")).toBe(true);
    expect(hash.split("$")).toHaveLength(4);
    // The plaintext must appear nowhere in the stored string.
    expect(hash).not.toContain("some-password-here");
  });

  it("verifies against a hash written with different parameters", async () => {
    // Simulates a hash created before a cost bump: the parameters travel
    // with the hash, so old passwords keep working.
    const legacy = "scrypt$N=1024,r=8,p=1$" + Buffer.from("0123456789abcdef").toString("base64");
    const { scryptSync } = await import("node:crypto");
    const derived = scryptSync("legacy-password-x", Buffer.from("0123456789abcdef"), 32, {
      N: 1024,
      r: 8,
      p: 1,
    });
    const stored = `${legacy}$${derived.toString("base64")}`;
    expect(await verifyPassword("legacy-password-x", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("returns false rather than throwing on a corrupt stored hash", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$$$", "scrypt$N=x,r=y,p=z$aa$bb", "bcrypt$a$b$c"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("generates passwords well past the enforced minimum", () => {
    const generated = generatePassword();
    expect(generated.length).toBeGreaterThan(MIN_PASSWORD_LENGTH);
    expect(generated).not.toBe(generatePassword());
  });
});
