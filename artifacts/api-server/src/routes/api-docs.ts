import { Router } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router = Router();

const SPEC_CANDIDATES: string[] = [
  path.resolve(process.cwd(), "lib/api-spec/openapi.yaml"),
  path.resolve(process.cwd(), "../../lib/api-spec/openapi.yaml"),
];

try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src-relative: artifacts/api-server/src/routes → workspace root
  SPEC_CANDIDATES.push(path.resolve(here, "../../../../lib/api-spec/openapi.yaml"));
  // dist-relative: artifacts/api-server/dist → workspace root
  SPEC_CANDIDATES.push(path.resolve(here, "../../../lib/api-spec/openapi.yaml"));
} catch {
  /* ignore */
}

async function resolveSpecPath(): Promise<string | null> {
  for (const candidate of SPEC_CANDIDATES) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

router.get("/docs/openapi.yaml", async (_req, res) => {
  const specPath = await resolveSpecPath();
  if (!specPath) {
    res.status(404).json({ error: "OpenAPI spec not found" });
    return;
  }
  const content = await readFile(specPath, "utf-8");
  res.setHeader("Content-Type", "application/yaml");
  res.setHeader("Cache-Control", "no-cache");
  res.send(content);
});

router.get("/docs", (_req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NabuFlow API Reference</title>
    <style>
      body { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <redoc spec-url="/api/docs/openapi.yaml"
           expand-responses="200,201"
           hide-download-button="false"
           theme='{"colors":{"primary":{"main":"#6366f1"}},"typography":{"fontFamily":"Inter, system-ui, sans-serif"}}'
    ></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(html);
});

export default router;
