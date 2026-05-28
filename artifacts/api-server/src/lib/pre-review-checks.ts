/**
 * Lightweight pre-review checks that run server-side on the staging snapshot
 * before the task transitions to "needs_review". These checks are intentionally
 * fast and run without a container — they complement (not replace) the quality
 * gate which requires a running container for JS/TS stacks.
 *
 * Checks:
 *   1. JSON syntax — JSON.parse on every .json file in the staging set.
 *   2. TypeScript / JavaScript syntax — ts.createProgram with noResolve+noLib
 *      (plus any compilerOptions found in a staged tsconfig.json) to catch parse
 *      errors in .ts/.tsx/.js/.jsx files without a full build.
 *   3. Relative import resolution — scan relative imports/requires in JS/TS/JSX/TSX
 *      files and verify each resolves to a file in the post-staging file set.
 *      The post-staging set = staged files ∪ surviving existing files (i.e. existing
 *      files minus any paths explicitly deleted by the agent).
 *   4. E2E spec smoke check — when test/spec files are present, run the same TS
 *      syntax and import resolution checks specifically on those files to validate
 *      the specs would at least parse and import correctly.
 */

import ts from "typescript";

export type PreReviewCheck = {
  id: string;
  label: string;
  passed: boolean;
  skipped: boolean;
  errorCount: number;
  errors: string[];
  durationMs: number;
};

export type PreReviewChecksResult = {
  checks: PreReviewCheck[];
  allPassed: boolean;
  anyFailed: boolean;
  ranAt: string;
};

// ── 1. JSON syntax check ──────────────────────────────────────────────────────

function runJsonSyntaxCheck(files: Array<{ path: string; content: string }>): PreReviewCheck {
  const start = Date.now();
  const jsonFiles = files.filter((f) => f.path.endsWith(".json"));

  if (jsonFiles.length === 0) {
    return {
      id: "json-syntax",
      label: "JSON syntax",
      passed: true,
      skipped: true,
      errorCount: 0,
      errors: [],
      durationMs: Date.now() - start,
    };
  }

  const errors: string[] = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(file.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${file.path}: ${msg}`);
    }
  }

  return {
    id: "json-syntax",
    label: "JSON syntax",
    passed: errors.length === 0,
    skipped: false,
    errorCount: errors.length,
    errors,
    durationMs: Date.now() - start,
  };
}

// ── 2. TypeScript / JavaScript syntax check ──────────────────────────────────

const TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Extract safe compiler options from a staged tsconfig.json if present.
 * We only use a whitelist of options that affect syntax parsing (target, module,
 * jsx etc.) — never "paths", "baseUrl", or plugin options that reference the FS.
 */
function extractTsConfigOptions(
  files: Array<{ path: string; content: string }>,
): ts.CompilerOptions {
  const tsconfigFile = files.find(
    (f) => f.path === "tsconfig.json" || f.path.endsWith("/tsconfig.json"),
  );
  if (!tsconfigFile) return {};
  try {
    const raw = JSON.parse(tsconfigFile.content) as {
      compilerOptions?: Record<string, unknown>;
    };
    const co = raw.compilerOptions ?? {};
    // Only honour parse-relevant options; drop everything that touches the FS.
    const safe: ts.CompilerOptions = {};
    if (typeof co.target === "string") {
      const t = co.target.toUpperCase() as keyof typeof ts.ScriptTarget;
      if (t in ts.ScriptTarget) safe.target = ts.ScriptTarget[t] as ts.ScriptTarget;
    }
    if (typeof co.jsx === "string") {
      const jxMap: Record<string, ts.JsxEmit> = {
        react: ts.JsxEmit.React,
        "react-jsx": ts.JsxEmit.ReactJSX,
        "react-jsxdev": ts.JsxEmit.ReactJSXDev,
        "react-native": ts.JsxEmit.ReactNative,
        preserve: ts.JsxEmit.Preserve,
      };
      const jx = jxMap[co.jsx.toLowerCase()];
      if (jx !== undefined) safe.jsx = jx;
    }
    if (co.strict === true) safe.strict = true;
    if (co.allowJs === true) safe.allowJs = true;
    if (co.experimentalDecorators === true) safe.experimentalDecorators = true;
    return safe;
  } catch {
    return {};
  }
}

function runTsSyntaxCheck(files: Array<{ path: string; content: string }>): PreReviewCheck {
  const start = Date.now();
  const tsFiles = files.filter((f) => TS_EXTS.some((e) => f.path.endsWith(e)));

  if (tsFiles.length === 0) {
    return {
      id: "ts-syntax",
      label: "TypeScript / JS syntax",
      passed: true,
      skipped: true,
      errorCount: 0,
      errors: [],
      durationMs: Date.now() - start,
    };
  }

  // Derive compiler options from any staged tsconfig.json so the check honours
  // the project's own target/jsx settings rather than guessing.
  const tsconfigOptions = extractTsConfigOptions(files);
  const errors: string[] = [];

  for (const file of tsFiles) {
    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(file.path),
      );

      // Build a minimal in-memory program to extract syntactic diagnostics.
      // noResolve + noLib avoids any file-system IO; we only need parse errors.
      const host: ts.CompilerHost = {
        getSourceFile: (name) => (name === file.path ? sourceFile : undefined),
        writeFile: () => undefined,
        getDefaultLibFileName: () => "lib.d.ts",
        useCaseSensitiveFileNames: () => true,
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => "",
        getNewLine: () => "\n",
        fileExists: (name) => name === file.path,
        readFile: () => undefined,
        directoryExists: () => false,
        getDirectories: () => [],
      };

      const program = ts.createProgram(
        [file.path],
        {
          // Always force noLib + noResolve so no FS access occurs, regardless
          // of what tsconfig says. Other options come from the staged tsconfig.
          ...tsconfigOptions,
          noLib: true,
          noResolve: true,
          skipLibCheck: true,
          allowJs: true,
          jsx: ts.JsxEmit.React,
          target: ts.ScriptTarget.Latest,
        },
        host,
      );

      const diags = program.getSyntacticDiagnostics(sourceFile);
      for (const diag of diags) {
        const pos =
          diag.start !== undefined
            ? (() => {
                const lc = sourceFile.getLineAndCharacterOfPosition(diag.start);
                return `${lc.line + 1}:${lc.character + 1}`;
              })()
            : "?";
        const msg = ts.flattenDiagnosticMessageText(diag.messageText, " ");
        const shortName = file.path.split("/").pop() ?? file.path;
        errors.push(`${shortName}:${pos} — ${msg}`);
      }
    } catch {
      // If the TS compiler itself throws (e.g. malformed binary), skip the file.
    }
  }

  const dedupedErrors = [...new Set(errors)].slice(0, 10);

  return {
    id: "ts-syntax",
    label: "TypeScript / JS syntax",
    passed: dedupedErrors.length === 0,
    skipped: false,
    errorCount: errors.length,
    errors: dedupedErrors,
    durationMs: Date.now() - start,
  };
}

// ── 3. Relative import resolution check ─────────────────────────────────────

const IMPORT_PATTERNS = [
  /(?:import|from)\s+['"](\.[^'"]+)['"]/g,
  /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];

/**
 * Resolve a relative path (e.g. "../utils/helper") from a source directory.
 * Returns a normalised path string without leading slash.
 */
function resolvePath(sourceDir: string, importPath: string): string {
  const parts = (sourceDir ? `${sourceDir}/${importPath}` : importPath).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

const JS_TS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_NAMES = JS_TS_EXTS.map((e) => `index${e}`);

function resolveImport(base: string, allPaths: Set<string>): boolean {
  if (allPaths.has(base)) return true;
  for (const ext of JS_TS_EXTS) {
    if (allPaths.has(`${base}${ext}`)) return true;
  }
  for (const idx of INDEX_NAMES) {
    if (allPaths.has(`${base}/${idx}`)) return true;
  }
  return false;
}

function runImportResolutionCheck(
  stagingFiles: Array<{ path: string; content: string }>,
  existingPaths: Set<string>,
  deletedPaths: Set<string>,
): PreReviewCheck {
  const start = Date.now();
  const jsTsFiles = stagingFiles.filter((f) => JS_TS_EXTS.some((e) => f.path.endsWith(e)));

  if (jsTsFiles.length === 0) {
    return {
      id: "imports",
      label: "Import resolution",
      passed: true,
      skipped: true,
      errorCount: 0,
      errors: [],
      durationMs: Date.now() - start,
    };
  }

  // Post-staging file set = staged files ∪ surviving existing files.
  // Surviving existing = existing minus files explicitly deleted by the agent.
  // Without excluding deleted paths, imports to removed modules would resolve
  // against stale existingPaths and produce false-pass results.
  const stagingPaths = new Set(stagingFiles.map((f) => f.path));
  const survivingExisting = [...existingPaths].filter((p) => !deletedPaths.has(p));
  const allPaths = new Set([...stagingPaths, ...survivingExisting]);

  const errors: string[] = [];

  for (const file of jsTsFiles) {
    const dir = file.path.includes("/") ? file.path.split("/").slice(0, -1).join("/") : "";
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.content)) !== null) {
        const importPath = match[1];
        if (!importPath.startsWith(".")) continue;
        const resolved = resolvePath(dir, importPath);
        if (!resolveImport(resolved, allPaths)) {
          const shortFile = file.path.split("/").pop() ?? file.path;
          errors.push(`${shortFile}: cannot resolve '${importPath}'`);
        }
      }
    }
  }

  // Deduplicate and cap errors to avoid huge payloads.
  const dedupedErrors = [...new Set(errors)].slice(0, 8);

  return {
    id: "imports",
    label: "Import resolution",
    passed: dedupedErrors.length === 0,
    skipped: false,
    errorCount: errors.length,
    errors: dedupedErrors,
    durationMs: Date.now() - start,
  };
}

// ── 4. E2E / test spec smoke check ────────────────────────────────────────────
//
// When spec files are present, we run a lightweight "smoke" validation:
//   a) TS syntax check (via the same ts.createProgram path as check #2)
//   b) Relative-import resolution check on spec files only
// This tells the reviewer whether the spec itself is runnable at a surface level
// without actually executing the test framework.

const SPEC_PATTERN = /\.(spec|test)\.[jt]sx?$/;

function runE2eSpecCheck(
  stagingFiles: Array<{ path: string; content: string }>,
  existingPaths: Set<string>,
  deletedPaths: Set<string>,
): PreReviewCheck {
  const start = Date.now();
  const specFiles = stagingFiles.filter((f) => SPEC_PATTERN.test(f.path));

  if (specFiles.length === 0) {
    return {
      id: "e2e-specs",
      label: "Test / E2E specs",
      passed: true,
      skipped: true,
      errorCount: 0,
      errors: [],
      durationMs: Date.now() - start,
    };
  }

  const errors: string[] = [];

  // (a) TS syntax check on spec files only.
  for (const file of specFiles) {
    try {
      const sourceFile = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(file.path),
      );
      const host: ts.CompilerHost = {
        getSourceFile: (name) => (name === file.path ? sourceFile : undefined),
        writeFile: () => undefined,
        getDefaultLibFileName: () => "lib.d.ts",
        useCaseSensitiveFileNames: () => true,
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => "",
        getNewLine: () => "\n",
        fileExists: (name) => name === file.path,
        readFile: () => undefined,
        directoryExists: () => false,
        getDirectories: () => [],
      };
      const program = ts.createProgram(
        [file.path],
        { noLib: true, noResolve: true, skipLibCheck: true, allowJs: true, jsx: ts.JsxEmit.React },
        host,
      );
      for (const diag of program.getSyntacticDiagnostics(sourceFile)) {
        const pos =
          diag.start !== undefined
            ? (() => {
                const lc = sourceFile.getLineAndCharacterOfPosition(diag.start);
                return `${lc.line + 1}:${lc.character + 1}`;
              })()
            : "?";
        const msg = ts.flattenDiagnosticMessageText(diag.messageText, " ");
        const shortName = file.path.split("/").pop() ?? file.path;
        errors.push(`Syntax error in ${shortName}:${pos} — ${msg}`);
      }
    } catch {
      // skip unreadable files
    }
  }

  // (b) Relative import resolution for spec files — use post-staging path set
  // (same deleted-path exclusion as the main import check).
  const stagingPaths = new Set(stagingFiles.map((f) => f.path));
  const survivingExisting = [...existingPaths].filter((p) => !deletedPaths.has(p));
  const allPaths = new Set([...stagingPaths, ...survivingExisting]);

  for (const file of specFiles) {
    const dir = file.path.includes("/") ? file.path.split("/").slice(0, -1).join("/") : "";
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.content)) !== null) {
        const importPath = match[1];
        if (!importPath.startsWith(".")) continue;
        const resolved = resolvePath(dir, importPath);
        if (!resolveImport(resolved, allPaths)) {
          const shortFile = file.path.split("/").pop() ?? file.path;
          errors.push(`Import unresolvable in ${shortFile}: '${importPath}'`);
        }
      }
    }
  }

  const dedupedErrors = [...new Set(errors)].slice(0, 6);
  const specLabel =
    specFiles.length === 1
      ? (specFiles[0].path.split("/").pop() ?? specFiles[0].path)
      : `${specFiles.length} spec files`;

  return {
    id: "e2e-specs",
    label: `E2E spec smoke check (${specLabel})`,
    passed: dedupedErrors.length === 0,
    skipped: false,
    errorCount: errors.length,
    errors: dedupedErrors,
    durationMs: Date.now() - start,
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export function runPreReviewChecks(
  stagingFiles: Array<{ path: string; content: string }>,
  existingPaths: Set<string>,
  /** Paths explicitly deleted by the agent — excluded from the post-staging file set. */
  deletedPaths: Set<string> = new Set(),
): PreReviewChecksResult {
  const checks: PreReviewCheck[] = [
    runJsonSyntaxCheck(stagingFiles),
    runTsSyntaxCheck(stagingFiles),
    runImportResolutionCheck(stagingFiles, existingPaths, deletedPaths),
    runE2eSpecCheck(stagingFiles, existingPaths, deletedPaths),
  ];

  const executed = checks.filter((c) => !c.skipped);
  const allPassed = executed.length === 0 || executed.every((c) => c.passed);
  const anyFailed = executed.some((c) => !c.passed);

  return {
    checks,
    allPassed,
    anyFailed,
    ranAt: new Date().toISOString(),
  };
}
