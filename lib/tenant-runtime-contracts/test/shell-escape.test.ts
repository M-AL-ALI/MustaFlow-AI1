import { describe, expect, it } from "vitest";
import { argvToCommandString, escapePosixShellArgument } from "../src/shell-escape";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

describe("argv command encoding", () => {
  it("quotes every argv entry and escapes adversarial shell input", () => {
    expect(
      argvToCommandString([
        "printf",
        "a b",
        "$(touch /tmp/pwn)",
        "x'y",
        "line1\nline2",
        "雪☃",
        "--flag=value; rm -rf /",
      ]),
    ).toBe(
      `'printf' 'a b' '$(touch /tmp/pwn)' 'x'"'"'y' 'line1\nline2' '雪☃' '--flag=value; rm -rf /'`,
    );
  });

  it.each([
    ["", "''"],
    ["plain", "'plain'"],
    ["'", `''"'"''`],
    ['"', `'"'`],
    ["$HOME && whoami", "'$HOME && whoami'"],
    ["a\rb\nc", "'a\rb\nc'"],
    ["emoji-🔐", "'emoji-🔐'"],
  ])("encodes %j as one POSIX shell word", (input, expected) => {
    expect(escapePosixShellArgument(input)).toBe(expected);
  });

  it("preserves the quoting invariant under 5,000 seeded fuzz cases", () => {
    const random = seededRandom(0x5ee1);
    const alphabet = [
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      " ",
      "\t",
      "\n",
      "\r",
      "'",
      '"',
      "$",
      "`",
      ";",
      "&",
      "|",
      "<",
      ">",
      "(",
      ")",
      "{",
      "}",
      "*",
      "?",
      "\\",
      "☃",
    ];

    for (let sample = 0; sample < 5_000; sample += 1) {
      const length = Math.floor(random() * 80);
      let argument = "";
      for (let index = 0; index < length; index += 1) {
        argument += alphabet[Math.floor(random() * alphabet.length)];
      }
      const encoded = escapePosixShellArgument(argument);
      expect(encoded.startsWith("'")).toBe(true);
      expect(encoded.endsWith("'")).toBe(true);
      expect(encoded.replaceAll(`'"'"'`, "").slice(1, -1)).not.toContain("'");
    }
  });

  it("rejects impossible or unbounded argv", () => {
    expect(() => argvToCommandString([])).toThrow("At least one");
    expect(() => argvToCommandString(["bad\0value"])).toThrow("NUL");
    expect(() => argvToCommandString(Array.from({ length: 257 }, () => "x"))).toThrow("256");
    expect(() => argvToCommandString(["x".repeat(70 * 1024)])).toThrow("65536");
  });
});
