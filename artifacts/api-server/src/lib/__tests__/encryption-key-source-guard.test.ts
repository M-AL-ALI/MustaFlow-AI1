/**
 * Source guard: asserts that no git-tracked file contains ENCRYPTION_KEY
 * directly followed by an assignment operator and a long value string.
 *
 * This catches accidental leaks into .replit, .env, shell exports, YAML, or
 * any other config format that assigns the secret value to the key name.
 * References in source code (process.env.ENCRYPTION_KEY, typeof checks, etc.)
 * do not match because they are not followed by = / : and a value.
 *
 * IMPORTANT: do not write a concrete example of the forbidden pattern anywhere
 * in this file — the guard scans its own source too.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

/**
 * Detects ENCRYPTION_KEY followed by an assignment operator (= or :) and then
 * a non-trivially-long base64-style value. Matches .replit / .env / YAML /
 * shell `export` style assignments. Does NOT match code references such as
 * `process.env.ENCRYPTION_KEY` or bare name-only mentions.
 */
const ASSIGNED_VALUE_PATTERN = /ENCRYPTION_KEY\s*[=:]\s*["']?[A-Za-z0-9+/]{20,}={0,2}/;

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".zip",
  ".tar",
  ".gz",
  ".lock",
  ".map",
  ".bin",
  ".wasm",
]);

describe("encryption-key source guard", () => {
  it("no tracked source file contains ENCRYPTION_KEY followed by a literal value", () => {
    const tracked = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => {
        const dot = f.lastIndexOf(".");
        const ext = dot >= 0 ? f.slice(dot).toLowerCase() : "";
        return !SKIP_EXTENSIONS.has(ext) && !f.startsWith(".agents/");
      });

    const violations: string[] = [];

    for (const rel of tracked) {
      let content: string;
      try {
        content = readFileSync(resolve(repoRoot, rel), "utf8");
      } catch {
        continue; // skip unreadable / true binary files
      }
      content.split("\n").forEach((line, i) => {
        if (ASSIGNED_VALUE_PATTERN.test(line)) {
          violations.push(`${rel}:${i + 1}`);
        }
      });
    }

    expect(
      violations,
      `ENCRYPTION_KEY assigned to a literal value in tracked file(s): ${violations.join(", ")}`,
    ).toHaveLength(0);
  });
});
