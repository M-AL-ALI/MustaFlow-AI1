/**
 * ESLint Runner
 *
 * Runs ESLint with eslint:recommended rules against generated JS files.
 * Uses the ESLint Linter class (flat config, no file system access needed).
 * Returns findings compatible with the check registry system.
 *
 * Web projects only. Findings are warnings (non-blocking for publish).
 */
import { Linter } from "eslint";
import js from "@eslint/js";
import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";
import { logger } from "../logger";

export type EslintFinding = {
  file: string;
  line: number | null;
  column: number | null;
  ruleId: string | null;
  severity: "error" | "warning";
  message: string;
};

/** Files we want to lint: plain JS (not TypeScript, not minified CDN files). */
function isLintableJs(file: BuilderFile): boolean {
  if (
    file.path.endsWith(".min.js") ||
    file.path.endsWith(".ts") ||
    file.path.endsWith(".tsx") ||
    file.path.endsWith(".jsx")
  ) {
    return false;
  }
  return (
    file.mimeType === "application/javascript" ||
    file.mimeType === "text/javascript" ||
    file.path.endsWith(".js") ||
    file.path.endsWith(".mjs")
  );
}

/**
 * Extract and lint inline <script> blocks from HTML files.
 * Skips type="text/babel", type="module" (may contain JSX / TS), and external src=.
 */
function extractInlineScripts(html: string): Array<{ code: string; lineOffset: number }> {
  const scripts: Array<{ code: string; lineOffset: number }> = [];
  const scriptPattern =
    /<script(?![^>]*type=["']text\/babel["'])(?![^>]*type=["']module["'])(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const code = (match[1] ?? "").trim();
    if (!code) continue;
    // Count newlines before match to calculate line offset
    const before = html.slice(0, match.index);
    const lineOffset = (before.match(/\n/g) ?? []).length;
    scripts.push({ code, lineOffset });
  }
  return scripts;
}

/**
 * Run ESLint against generated JS files and HTML inline scripts.
 * Returns { status, findings } compatible with the check orchestrator.
 */
export function runEslintCheck(files: BuilderFile[]): {
  status: CheckRunStatus;
  findings: CheckFinding[];
} {
  const linter = new Linter({ configType: "flat" });
  const config = [
    {
      ...js.configs.recommended,
      languageOptions: {
        ecmaVersion: 2020 as const,
        sourceType: "script" as const,
        globals: {
          window: "readonly",
          document: "readonly",
          navigator: "readonly",
          console: "readonly",
          fetch: "readonly",
          setTimeout: "readonly",
          clearTimeout: "readonly",
          setInterval: "readonly",
          clearInterval: "readonly",
          alert: "readonly",
          confirm: "readonly",
          localStorage: "readonly",
          sessionStorage: "readonly",
          location: "readonly",
          history: "readonly",
          Event: "readonly",
          CustomEvent: "readonly",
          FormData: "readonly",
          Promise: "readonly",
          URL: "readonly",
          URLSearchParams: "readonly",
          L: "readonly",
          React: "readonly",
          ReactDOM: "readonly",
          lucide: "readonly",
          tailwind: "readonly",
          luxon: "readonly",
          Chart: "readonly",
          hljs: "readonly",
        },
      },
    },
  ];

  const allFindings: CheckFinding[] = [];

  for (const file of files) {
    const isJs = isLintableJs(file);
    const isHtml = file.mimeType === "text/html" || file.path.endsWith(".html");

    if (!isJs && !isHtml) continue;

    const codeBlocks: Array<{ code: string; path: string; lineOffset: number }> = [];

    if (isJs) {
      codeBlocks.push({ code: file.content, path: file.path, lineOffset: 0 });
    } else if (isHtml) {
      const scripts = extractInlineScripts(file.content);
      for (const s of scripts) {
        codeBlocks.push({ code: s.code, path: file.path, lineOffset: s.lineOffset });
      }
    }

    for (const block of codeBlocks) {
      let messages: ReturnType<Linter["verify"]>;
      try {
        messages = linter.verify(block.code, config, { filename: block.path });
      } catch (err) {
        logger.warn({ err, path: block.path }, "ESLint: linter.verify threw — skipping file");
        continue;
      }

      for (const msg of messages) {
        // Skip parsing errors — those are caught by the syntax checker
        if (msg.fatal) continue;

        const adjustedLine = msg.line !== undefined ? msg.line + block.lineOffset : null;

        allFindings.push({
          file: file.path,
          line: adjustedLine ?? undefined,
          message: msg.message,
          detail: msg.ruleId ? `Rule: ${msg.ruleId}` : undefined,
          severity: msg.severity === 2 ? "error" : "warning",
        });
      }
    }
  }

  const hasErrors = allFindings.some((f) => f.severity === "error");
  const status: CheckRunStatus =
    allFindings.length === 0 ? "pass" : hasErrors ? "warning" : "warning";

  return { status, findings: allFindings };
}
