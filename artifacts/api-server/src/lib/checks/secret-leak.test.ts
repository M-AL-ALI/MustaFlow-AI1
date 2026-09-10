import { describe, expect, it } from "vitest";
import { runSecretLeakCheck } from "./secret-leak";

// Construct an unmistakably synthetic value; never use a real credential.
const synthetic = "sk-" + "Ab12".repeat(8);
const literal = 'const apiKey = "' + synthetic + '";';

function scan(content: string) {
  return runSecretLeakCheck([{ path: "src/app.ts", content }]);
}

describe("secret-check placeholder boundaries", () => {
  it("detects the literal control", () => {
    expect(scan(literal).status).toBe("fail");
  });

  it.each(["test", "live"])("preserves %s publishable-key placeholders", (mode) => {
    const placeholder = "pk_" + mode + "_" + "X".repeat(24);
    expect(scan('const publicKey = "' + placeholder + '";')).toEqual({
      checkName: "secret-leak",
      status: "pass",
      findings: [],
    });
  });

  it.each([
    ["test", ""],
    ["live", ""],
    ["test", " // process.env.PUBLIC_KEY"],
    ["live", " // placeholder for another setting"],
  ])("checks and masks the complete %s token next to %s", (mode, comment) => {
    const token = "pk_" + mode + "_" + "Ab12".repeat(6);
    const result = scan('// Header\nconst publicKey = "' + token + '";' + comment);
    expect(result.status).toBe("fail");
    expect(result.findings).toEqual([
      expect.objectContaining({
        file: "src/app.ts",
        line: 2,
        severity: "error",
        message: "Stripe publishable key detected: " + token.slice(0, 4) + "****" + token.slice(-4),
      }),
    ]);
    expect(JSON.stringify(result.findings)).not.toContain(token);
  });

  it.each([
    "// process.env.PROVIDER_API_KEY",
    "// import.meta.env.VITE_PUBLIC_VALUE",
    "// placeholder for a later environment migration",
    "// XXXX",
    "// read other values from project secrets",
    "// ${environmentName}",
  ])("does not exempt a hardcoded credential next to %s", (comment) => {
    const result = scan(literal + " " + comment);
    expect(result.status).toBe("fail");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/app.ts", line: 1, severity: "error" }),
      ]),
    );
  });

  it.each([
    "const apiKey = process.env.PROVIDER_API_KEY;",
    "const apiKey = import.meta.env.VITE_PUBLIC_VALUE;",
    'const apiKey = "your_api_key_placeholder";',
    'const password = "XXXXXXXXXXXX";',
  ])("retains legitimate references and placeholder values: %s", (content) => {
    expect(scan(content)).toEqual({
      checkName: "secret-leak",
      status: "pass",
      findings: [],
    });
  });

  it("retains masking and exact file/line metadata without changing input", () => {
    const content = "// Header\n" + literal + " // process.env.OTHER_VALUE";
    const file = Object.freeze({ path: "src/private-config.ts", content });
    const files = Object.freeze([file]);
    const result = runSecretLeakCheck(files);
    expect(result.status).toBe("fail");
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.file).toBe(file.path);
      expect(finding.line).toBe(2);
      expect(finding.message).toContain("****");
      expect(finding.message).not.toContain(synthetic);
      expect(finding.detail).not.toContain(synthetic);
    }
    expect(file.content).toBe(content);
  });
});
