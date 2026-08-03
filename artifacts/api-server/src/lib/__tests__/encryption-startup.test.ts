/**
 * Two-path startup check tests for the encryption service.
 *
 * Path A — valid key: the service initialises, round-trip succeeds, and
 *           getEncryptionKeyStatus() returns "ok".
 *
 * Path B — simulated bad key: createEncryptionService throws, which in
 *           buildEncryptionService causes the catch branch to set the status
 *           to "invalid" and log a loud error (dev) or crash (prod).
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createEncryptionService, getEncryptionKeyStatus } from "../encryption";

describe("encryption startup — valid key path", () => {
  it("constructs successfully with a fresh 32-byte key", () => {
    const key = randomBytes(32).toString("base64");
    const svc = createEncryptionService(key);
    expect(svc.isDevelopmentOnly).toBe(false);
  });

  it("round-trip probe: encrypt then decrypt returns the original string", () => {
    const key = randomBytes(32).toString("base64");
    const svc = createEncryptionService(key);
    const probe = "enc-startup-probe";
    expect(svc.decrypt(svc.encrypt(probe))).toBe(probe);
  });

  it("getEncryptionKeyStatus() is 'ok' when ENCRYPTION_KEY is set correctly in this environment", () => {
    // ENCRYPTION_KEY is set as a Replit Secret in dev; buildEncryptionService
    // runs the round-trip probe at module load and sets status to "ok".
    expect(getEncryptionKeyStatus()).toBe("ok");
  });
});

describe("encryption startup — simulated bad key path", () => {
  it("createEncryptionService throws when key decodes to wrong byte length", () => {
    // A key that base64-decodes to fewer than 32 bytes must be rejected.
    const shortKey = Buffer.from("tooshort").toString("base64");
    expect(() => createEncryptionService(shortKey)).toThrow("32 bytes");
  });

  it("createEncryptionService throws on a non-base64 string", () => {
    // Non-base64 input decodes to a buffer that is unlikely to be 32 bytes.
    // We check it either throws or produces a wrong-length error.
    expect(() => {
      const svc = createEncryptionService("not-valid-base64!!!");
      // If construction somehow didn't throw, force a round-trip —
      // AES-256-GCM will fail with an authentication error.
      svc.decrypt(svc.encrypt("probe"));
    }).toThrow();
  });

  it("a key with correct length but corrupted ciphertext fails on decrypt", () => {
    // Key A encrypts; Key B decrypts → GCM authentication tag mismatch.
    const keyA = randomBytes(32).toString("base64");
    const keyB = randomBytes(32).toString("base64");
    const svcA = createEncryptionService(keyA);
    const svcB = createEncryptionService(keyB);
    const ct = svcA.encrypt("secret-value");
    expect(() => svcB.decrypt(ct)).toThrow();
  });
});
