/**
 * Phase 2G regression tests — dependency scanner.
 *
 * Verifies that scanMissingDeps correctly identifies packages imported by
 * workspace files but absent from package.json, and that addMissingToDeps
 * patches the manifest correctly.
 *
 * Run with: pnpm --filter @workspace/api-server run test
 */

import { describe, it, expect } from "vitest";
import { scanMissingDeps, addMissingToDeps } from "./dep-scanner";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFiles(pkg: Record<string, unknown>, sources: Record<string, string>) {
  return [
    { path: "package.json", content: JSON.stringify(pkg, null, 2) },
    ...Object.entries(sources).map(([path, content]) => ({ path, content })),
  ];
}

// ─── scanMissingDeps ─────────────────────────────────────────────────────────

describe("scanMissingDeps", () => {
  it("returns empty array when no package.json exists", () => {
    const files = [{ path: "src/index.ts", content: "import 'react-router-dom'" }];
    expect(scanMissingDeps(files)).toEqual([]);
  });

  it("returns empty array when all imports are declared", () => {
    const files = makeFiles(
      { dependencies: { "react-router-dom": "^6.0.0" } },
      { "src/app.tsx": "import { BrowserRouter } from 'react-router-dom'" },
    );
    expect(scanMissingDeps(files)).toEqual([]);
  });

  // Regression: Phase 2G primary scenario
  it("detects react-router-dom missing from package.json", () => {
    const files = makeFiles(
      { dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } },
      {
        "src/App.tsx": `
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
export default function App() {
  return <BrowserRouter><Routes><Route path="/" element={<div>Home</div>} /></Routes></BrowserRouter>;
}
`,
      },
    );
    expect(scanMissingDeps(files)).toContain("react-router-dom");
  });

  it("handles scoped packages like @tanstack/react-query", () => {
    const files = makeFiles(
      { dependencies: { react: "^18.0.0" } },
      {
        "src/queries.ts": `
import { useQuery } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
`,
      },
    );
    const missing = scanMissingDeps(files);
    expect(missing).toContain("@tanstack/react-query");
    // Should only appear once even though imported twice
    expect(missing.filter((p) => p === "@tanstack/react-query")).toHaveLength(1);
  });

  it("ignores Node.js built-ins", () => {
    const files = makeFiles(
      { dependencies: {} },
      {
        "src/server.ts": `
import * as fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import { promisify } from 'util';
`,
      },
    );
    expect(scanMissingDeps(files)).toEqual([]);
  });

  it("ignores node: prefixed builtins", () => {
    const files = makeFiles(
      { dependencies: {} },
      { "src/index.ts": "import { readFile } from 'node:fs/promises'" },
    );
    expect(scanMissingDeps(files)).toEqual([]);
  });

  it("ignores relative and absolute imports", () => {
    const files = makeFiles(
      { dependencies: {} },
      {
        "src/a.ts": `
import { foo } from './foo';
import { bar } from '../bar';
import { baz } from '/absolute/path';
`,
      },
    );
    expect(scanMissingDeps(files)).toEqual([]);
  });

  it("detects packages used via require()", () => {
    const files = makeFiles(
      { dependencies: {} },
      { "src/legacy.js": "const express = require('express');" },
    );
    expect(scanMissingDeps(files)).toContain("express");
  });

  it("detects packages via dynamic import()", () => {
    const files = makeFiles(
      { dependencies: {} },
      { "src/loader.ts": "const mod = await import('lodash');" },
    );
    expect(scanMissingDeps(files)).toContain("lodash");
  });

  it("only scans JS/TS files (ignores html, css, json)", () => {
    const files = [
      {
        path: "package.json",
        content: JSON.stringify({ dependencies: {} }, null, 2),
      },
      {
        path: "index.html",
        content: "<script>import 'some-lib'</script>",
      },
      {
        path: "src/styles.css",
        content: "/* import 'not-a-package' */",
      },
    ];
    expect(scanMissingDeps(files)).toEqual([]);
  });

  it("handles devDependencies and peerDependencies as declared", () => {
    const files = makeFiles(
      {
        devDependencies: { typescript: "^5.0.0" },
        peerDependencies: { react: "^18.0.0" },
      },
      { "src/index.ts": "import React from 'react'; import ts from 'typescript';" },
    );
    expect(scanMissingDeps(files)).toEqual([]);
  });

  it("handles subpath imports (pkg/subpath → pkg name)", () => {
    const files = makeFiles(
      { dependencies: {} },
      { "src/index.ts": "import { something } from 'some-pkg/deep/subpath';" },
    );
    expect(scanMissingDeps(files)).toContain("some-pkg");
    // Must not contain the full subpath
    expect(scanMissingDeps(files)).not.toContain("some-pkg/deep/subpath");
  });

  it("detects multiple missing packages at once", () => {
    const files = makeFiles(
      { dependencies: { react: "^18.0.0" } },
      {
        "src/app.tsx": `
import { BrowserRouter } from 'react-router-dom';
import axios from 'axios';
import { QueryClient } from '@tanstack/react-query';
import React from 'react';
`,
      },
    );
    const missing = scanMissingDeps(files);
    expect(missing).toContain("react-router-dom");
    expect(missing).toContain("axios");
    expect(missing).toContain("@tanstack/react-query");
    expect(missing).not.toContain("react");
  });

  it("handles import type statements", () => {
    const files = makeFiles(
      { dependencies: {} },
      { "src/types.ts": "import type { FC } from 'some-ui-lib';" },
    );
    expect(scanMissingDeps(files)).toContain("some-ui-lib");
  });
});

// ─── addMissingToDeps ────────────────────────────────────────────────────────

describe("addMissingToDeps", () => {
  it("adds missing packages with * version", () => {
    const pkg = JSON.stringify({ name: "app", dependencies: { react: "^18.0.0" } }, null, 2);
    const result = addMissingToDeps(pkg, ["react-router-dom"]);
    const parsed = JSON.parse(result) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["react-router-dom"]).toBe("*");
  });

  it("does not overwrite existing version pins", () => {
    const pkg = JSON.stringify({ dependencies: { "react-router-dom": "^6.0.0" } }, null, 2);
    const result = addMissingToDeps(pkg, ["react-router-dom"]);
    const parsed = JSON.parse(result) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["react-router-dom"]).toBe("^6.0.0");
  });

  it("returns original string unchanged when missing list is empty", () => {
    const pkg = '{"dependencies":{"react":"^18.0.0"}}';
    expect(addMissingToDeps(pkg, [])).toBe(pkg);
  });

  it("returns original string unchanged when JSON is invalid", () => {
    const bad = "NOT JSON";
    expect(addMissingToDeps(bad, ["react-router-dom"])).toBe(bad);
  });

  it("creates dependencies object if absent", () => {
    const pkg = JSON.stringify({ name: "app", scripts: { start: "node index.js" } }, null, 2);
    const result = addMissingToDeps(pkg, ["express"]);
    const parsed = JSON.parse(result) as { dependencies?: Record<string, string> };
    expect(parsed.dependencies?.["express"]).toBe("*");
  });

  it("adds multiple packages in one call", () => {
    const pkg = JSON.stringify({ dependencies: {} }, null, 2);
    const result = addMissingToDeps(pkg, ["axios", "react-router-dom", "@tanstack/react-query"]);
    const parsed = JSON.parse(result) as { dependencies: Record<string, string> };
    expect(parsed.dependencies["axios"]).toBe("*");
    expect(parsed.dependencies["react-router-dom"]).toBe("*");
    expect(parsed.dependencies["@tanstack/react-query"]).toBe("*");
  });

  // Phase 2G full-cycle regression
  it("round-trips: scan detects missing, addMissingToDeps fixes it, re-scan returns empty", () => {
    const initial = makeFiles(
      { dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } },
      {
        "src/App.tsx": `
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
`,
      },
    );

    const missing = scanMissingDeps(initial);
    expect(missing).toContain("react-router-dom");

    // Patch package.json
    const pkgFile = initial.find((f) => f.path === "package.json")!;
    const patched = addMissingToDeps(pkgFile.content, missing);

    // Re-scan with patched package.json
    const updated = initial.map((f) =>
      f.path === "package.json" ? { ...f, content: patched } : f,
    );
    expect(scanMissingDeps(updated)).toEqual([]);
  });
});
