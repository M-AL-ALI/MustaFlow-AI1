/**
 * ESLint Runner
 *
 * Runs ESLint with eslint:recommended rules against generated JS files
 * and TypeScript files (.ts/.tsx) using @typescript-eslint/parser.
 * Uses the ESLint Linter class (flat config, no file system access needed).
 * Returns findings compatible with the check registry system.
 *
 * Runs for both web (JS) and mobile (TS/TSX) projects. Findings are warnings
 * (non-blocking for publish).
 */
import { Linter } from "eslint";
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
// eslint-plugin-react and eslint-plugin-react-hooks ship without TS types here.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no bundled types
import reactPlugin from "eslint-plugin-react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no bundled types
import reactHooksPlugin from "eslint-plugin-react-hooks";
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

/** TypeScript files we want to lint (.ts/.tsx, excluding declaration files). */
function isLintableTs(file: BuilderFile): boolean {
  if (file.path.endsWith(".d.ts")) return false;
  return file.path.endsWith(".ts") || file.path.endsWith(".tsx");
}

/**
 * Extract and lint inline <script> blocks from HTML files.
 * Skips type="text/babel", type="module" (may contain JSX / TS), and external src=.
 *
 * Returns each block's raw inner content along with the [innerStart, innerEnd)
 * byte offsets inside the HTML so callers can splice fixed code back in.
 * `lineOffset` is the number of newlines preceding the inner content (used to
 * map ESLint message line numbers back into HTML coordinates).
 */
function extractInlineScripts(html: string): Array<{
  code: string;
  innerStart: number;
  innerEnd: number;
  lineOffset: number;
}> {
  const scripts: Array<{
    code: string;
    innerStart: number;
    innerEnd: number;
    lineOffset: number;
  }> = [];
  const scriptPattern =
    /<script(?![^>]*type=["']text\/babel["'])(?![^>]*type=["']module["'])(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const fullMatch = match[0];
    const openTagLen = fullMatch.indexOf(">") + 1;
    const closeIdx = fullMatch.toLowerCase().lastIndexOf("</script");
    if (openTagLen <= 0 || closeIdx < 0) continue;
    const innerStart = match.index + openTagLen;
    const innerEnd = match.index + closeIdx;
    const code = html.slice(innerStart, innerEnd);
    if (!code.trim()) continue;
    const before = html.slice(0, innerStart);
    const lineOffset = (before.match(/\n/g) ?? []).length;
    scripts.push({ code, innerStart, innerEnd, lineOffset });
  }
  return scripts;
}

/**
 * Build the shared globals + per-language ESLint configs used by both the
 * check runner and the on-demand "auto-fix" endpoint. Extracted into a single
 * function so server-side linting and editor auto-fixing always agree.
 */
function buildEslintConfigs(): {
  jsConfig: Linter.Config[];
  tsConfig: Linter.Config[];
} {
  const sharedGlobals = {
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
  };

  // Curated stricter rules layered on top of eslint:recommended for plain JS
  // (and inline <script> blocks). These catch a class of common AI mistakes
  // that `eslint:recommended` alone misses — implicit globals, accidental
  // assignment in returns, fall-through switches, eval-like patterns, loose
  // equality, shadowed bindings, self-compares, etc. All non-blocking warnings
  // so they surface in the Quality panel without failing publish.
  const jsStricterRules: Linter.RulesRecord = {
    eqeqeq: ["warn", "smart"],
    "no-implicit-globals": "warn",
    "no-shadow": "warn",
    "no-eval": "warn",
    "no-implied-eval": "warn",
    "no-new-func": "warn",
    "no-return-assign": ["warn", "always"],
    "no-self-compare": "warn",
    "no-unmodified-loop-condition": "warn",
    "no-unreachable-loop": "warn",
    "no-constructor-return": "warn",
    "no-duplicate-imports": "warn",
    "no-promise-executor-return": "warn",
    "no-template-curly-in-string": "warn",
    "default-case": "warn",
    "default-case-last": "warn",
    "no-throw-literal": "warn",
    "no-var": "warn",
    "prefer-const": "warn",
    radix: "warn",
  };

  const jsConfig = [
    {
      ...js.configs.recommended,
      languageOptions: {
        ecmaVersion: 2020 as const,
        sourceType: "script" as const,
        globals: sharedGlobals,
      },
      rules: {
        ...js.configs.recommended.rules,
        ...jsStricterRules,
      },
    },
  ];

  // TS/TSX config uses @typescript-eslint/parser plus React + React Hooks
  // plugins so mobile (Expo) projects catch hook-rule violations, missing
  // deps, unkeyed list items, etc. Type-info-requiring rules are skipped
  // (no tsconfig project is wired up); tsc runs separately as the "typescript"
  // check and covers what those would.
  const tsPluginRules =
    (
      tsPlugin as unknown as {
        configs: Record<string, { rules?: Record<string, unknown> }>;
      }
    ).configs.recommended?.rules ?? {};
  const reactPluginRules =
    (
      reactPlugin as unknown as {
        configs: Record<string, { rules?: Record<string, unknown> }>;
      }
    ).configs.recommended?.rules ?? {};
  const reactHooksPluginRules =
    (
      reactHooksPlugin as unknown as {
        configs: Record<string, { rules?: Record<string, unknown> }>;
      }
    ).configs.recommended?.rules ?? {};

  const tsConfig = [
    {
      languageOptions: {
        parser: tsParser as unknown as Linter.Parser,
        ecmaVersion: 2022 as const,
        sourceType: "module" as const,
        parserOptions: {
          ecmaFeatures: { jsx: true },
        },
        globals: {
          ...sharedGlobals,
          require: "readonly",
          module: "readonly",
          process: "readonly",
          __dirname: "readonly",
          __filename: "readonly",
          global: "readonly",
        },
      },
      plugins: {
        "@typescript-eslint": tsPlugin,
        react: reactPlugin,
        "react-hooks": reactHooksPlugin,
      } as unknown as Linter.Config["plugins"],
      settings: {
        react: { version: "detect" },
      },
      rules: {
        ...js.configs.recommended.rules,
        ...(tsPluginRules as Linter.RulesRecord),
        ...(reactPluginRules as Linter.RulesRecord),
        ...(reactHooksPluginRules as Linter.RulesRecord),
        // tsc handles undefined identifiers; ESLint's no-undef misfires on TS types.
        "no-undef": "off" as const,
        // tsc's noUnusedLocals/noUnusedParameters cover this better for TS.
        "no-unused-vars": "off" as const,
        "@typescript-eslint/no-unused-vars": "off" as const,
        // Modern React (Expo SDK 52 / React 18+) doesn't need React in scope.
        "react/react-in-jsx-scope": "off" as const,
        // TS types replace prop-types in mobile projects.
        "react/prop-types": "off" as const,
        // Some hooks v7 recommended rules require type info or are too opinionated
        // for AI-generated mobile code; keep the two the task explicitly calls out
        // plus core hooks correctness, drop the experimental ones.
        "react-hooks/static-components": "off" as const,
        "react-hooks/use-memo": "off" as const,
        "react-hooks/preserve-manual-memoization": "off" as const,
        "react-hooks/incompatible-library": "off" as const,
        "react-hooks/immutability": "off" as const,
        "react-hooks/globals": "off" as const,
        "react-hooks/refs": "off" as const,
        "react-hooks/set-state-in-effect": "off" as const,
        "react-hooks/set-state-in-render": "off" as const,
        "react-hooks/unsupported-syntax": "off" as const,
        "react-hooks/purity": "off" as const,
        "react-hooks/error-boundaries": "off" as const,
        "react-hooks/component-hook-factories": "off" as const,
        "react-hooks/config": "off" as const,
        "react-hooks/gating": "off" as const,
        // Re-assert the two rules the task explicitly requires.
        "react-hooks/rules-of-hooks": "error" as const,
        "react-hooks/exhaustive-deps": "warn" as const,
      },
    },
  ] satisfies Linter.Config[];

  return { jsConfig, tsConfig };
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
  const { jsConfig, tsConfig } = buildEslintConfigs();

  const allFindings: CheckFinding[] = [];

  for (const file of files) {
    const isJs = isLintableJs(file);
    const isTs = isLintableTs(file);
    const isHtml = file.mimeType === "text/html" || file.path.endsWith(".html");

    if (!isJs && !isTs && !isHtml) continue;

    const codeBlocks: Array<{
      code: string;
      path: string;
      lineOffset: number;
      config: Linter.Config[];
    }> = [];

    if (isJs) {
      codeBlocks.push({ code: file.content, path: file.path, lineOffset: 0, config: jsConfig });
    } else if (isTs) {
      codeBlocks.push({ code: file.content, path: file.path, lineOffset: 0, config: tsConfig });
    } else if (isHtml) {
      const scripts = extractInlineScripts(file.content);
      for (const s of scripts) {
        codeBlocks.push({
          code: s.code,
          path: file.path,
          lineOffset: s.lineOffset,
          config: jsConfig,
        });
      }
    }

    for (const block of codeBlocks) {
      let messages: ReturnType<Linter["verify"]>;
      try {
        messages = linter.verify(block.code, block.config, { filename: block.path });
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

export type EslintFixableIssue = {
  ruleId: string | null;
  line: number;
  column: number;
  endLine: number | null;
  endColumn: number | null;
  message: string;
  severity: "error" | "warning";
};

/**
 * Apply ESLint's auto-fixers to a single file's content.
 *
 * - If `ruleIds` is provided, only messages whose ruleId is in that list are fixed.
 * - Returns the post-fix output and the list of issues that remained after fixing.
 *
 * Supports plain JS (`.js`, `.mjs`), TS/TSX files, and HTML files (auto-fix
 * only runs on inline `<script>` blocks; the surrounding HTML is preserved
 * byte-for-byte). Returns `{ supported: false }` for any other path so the
 * caller can render an appropriate UI state.
 */
export function runEslintFix(opts: { path: string; content: string; ruleIds?: string[] }): {
  supported: boolean;
  output: string;
  changed: boolean;
  remaining: EslintFixableIssue[];
} {
  const file: BuilderFile = {
    path: opts.path,
    content: opts.content,
    mimeType: guessMimeForPath(opts.path),
  };

  const isJs = isLintableJs(file);
  const isTs = isLintableTs(file);
  const isHtml =
    file.mimeType === "text/html" ||
    opts.path.toLowerCase().endsWith(".html") ||
    opts.path.toLowerCase().endsWith(".htm");
  if (!isJs && !isTs && !isHtml) {
    return { supported: false, output: opts.content, changed: false, remaining: [] };
  }

  const linter = new Linter({ configType: "flat" });
  const { jsConfig, tsConfig } = buildEslintConfigs();

  const ruleFilter = opts.ruleIds && opts.ruleIds.length > 0 ? new Set(opts.ruleIds) : null;
  const fixOption: Linter.FixOptions = {
    filename: opts.path,
    fix: (ruleFilter
      ? (msg: Linter.LintMessage) => !!msg.ruleId && ruleFilter.has(msg.ruleId)
      : true) as unknown as boolean,
  };

  if (isHtml) {
    return runEslintFixHtml({
      linter,
      jsConfig,
      content: opts.content,
      path: opts.path,
      fixOption,
    });
  }

  const config = isTs ? tsConfig : jsConfig;

  let result: ReturnType<Linter["verifyAndFix"]>;
  try {
    result = linter.verifyAndFix(opts.content, config, fixOption);
  } catch (err) {
    logger.warn({ err, path: opts.path }, "ESLint: verifyAndFix threw");
    return { supported: true, output: opts.content, changed: false, remaining: [] };
  }

  const remaining: EslintFixableIssue[] = (result.messages ?? [])
    .filter((m) => !m.fatal)
    .map((m) => ({
      ruleId: m.ruleId ?? null,
      line: m.line ?? 1,
      column: m.column ?? 1,
      endLine: m.endLine ?? null,
      endColumn: m.endColumn ?? null,
      message: m.message,
      severity: m.severity === 2 ? "error" : "warning",
    }));

  return {
    supported: true,
    output: result.output,
    changed: result.output !== opts.content,
    remaining,
  };
}

/**
 * Auto-fix inline `<script>` blocks inside an HTML file.
 *
 * Each lintable block is fixed independently; the surrounding HTML
 * (indentation, attributes, whitespace) is preserved exactly by splicing the
 * post-fix code back at the original byte offsets. We walk blocks in reverse
 * order so earlier offsets stay valid as later ones grow or shrink. Remaining
 * issues are reported with line numbers translated back to HTML coordinates
 * via each block's `lineOffset`.
 */
function runEslintFixHtml(args: {
  linter: Linter;
  jsConfig: Linter.Config[];
  content: string;
  path: string;
  fixOption: Linter.FixOptions;
}): {
  supported: boolean;
  output: string;
  changed: boolean;
  remaining: EslintFixableIssue[];
} {
  const { linter, jsConfig, content, path, fixOption } = args;
  const blocks = extractInlineScripts(content);
  if (blocks.length === 0) {
    return { supported: true, output: content, changed: false, remaining: [] };
  }

  type BlockResult = {
    innerStart: number;
    innerEnd: number;
    lineOffset: number;
    output: string;
    original: string;
    messages: Linter.LintMessage[];
  };
  const results: BlockResult[] = [];

  for (const block of blocks) {
    let res: ReturnType<Linter["verifyAndFix"]>;
    try {
      res = linter.verifyAndFix(block.code, jsConfig, fixOption);
    } catch (err) {
      logger.warn({ err, path }, "ESLint: verifyAndFix threw on inline <script>");
      results.push({
        innerStart: block.innerStart,
        innerEnd: block.innerEnd,
        lineOffset: block.lineOffset,
        output: block.code,
        original: block.code,
        messages: [],
      });
      continue;
    }
    results.push({
      innerStart: block.innerStart,
      innerEnd: block.innerEnd,
      lineOffset: block.lineOffset,
      output: res.output,
      original: block.code,
      messages: res.messages ?? [],
    });
  }

  let output = content;
  let changed = false;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]!;
    if (r.output !== r.original) {
      output = output.slice(0, r.innerStart) + r.output + output.slice(r.innerEnd);
      changed = true;
    }
  }

  const remaining: EslintFixableIssue[] = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.fatal) continue;
      remaining.push({
        ruleId: m.ruleId ?? null,
        line: (m.line ?? 1) + r.lineOffset,
        column: m.column ?? 1,
        endLine: m.endLine !== undefined && m.endLine !== null ? m.endLine + r.lineOffset : null,
        endColumn: m.endColumn ?? null,
        message: m.message,
        severity: m.severity === 2 ? "error" : "warning",
      });
    }
  }

  return { supported: true, output, changed, remaining };
}

/**
 * Minimal mime guess for the `runEslintFix` helper so it can build a
 * `BuilderFile` without importing from `../builder` and creating a cycle.
 */
function guessMimeForPath(p: string): string {
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "application/typescript";
  if (p.endsWith(".mjs") || p.endsWith(".js")) return "application/javascript";
  if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
  return "text/plain";
}
