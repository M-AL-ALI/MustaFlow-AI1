import { describe, expect, it } from "vitest";
import { parseDotEnvSecrets, parseJsonSecrets, SecretImportError } from "./secrets-import";

describe("project secret import", () => {
  it("parses a complete .env paste without executing interpolation", () => {
    expect(
      parseDotEnvSecrets(
        [
          "# Project values",
          "export API_KEY=sk-test-123",
          'DATABASE_URL="postgres://example/db?x=1"',
          "LITERAL=$DO_NOT_EXPAND",
        ].join("\n"),
      ),
    ).toEqual([
      { name: "API_KEY", value: "sk-test-123" },
      { name: "DATABASE_URL", value: "postgres://example/db?x=1" },
      { name: "LITERAL", value: "$DO_NOT_EXPAND" },
    ]);
  });

  it("uses the last pasted value for a duplicate name", () => {
    expect(parseDotEnvSecrets("API_KEY=old\nAPI_KEY=new")).toEqual([
      { name: "API_KEY", value: "new" },
    ]);
  });

  it("rejects invalid environment-variable names and missing values", () => {
    expect(() => parseDotEnvSecrets("BAD-NAME=value")).toThrow(SecretImportError);
    expect(() => parseDotEnvSecrets("EMPTY=")).toThrow("has no value");
  });

  it("parses JSON string values and rejects non-string values", () => {
    expect(parseJsonSecrets('{"API_KEY":"secret"}')).toEqual([
      { name: "API_KEY", value: "secret" },
    ]);
    expect(() => parseJsonSecrets('{"COUNT":1}')).toThrow("must have a string value");
  });
});
