import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  chatMessagesTable,
  agentTasksTable,
  projectActivityTable,
} from "@workspace/db";
import { requireProjectOwnership, requireProjectAccess } from "../lib/auth";
import {
  CreateProjectBody,
  GetProjectParams,
  GetProjectResponse,
  ListProjectsResponse,
  UpdateProjectBody,
  UpdateProjectParams,
  UpdateProjectResponse,
  DeleteProjectParams,
  GetProjectsSummaryResponse,
  GetAgentRoutingParams,
  GetAgentRoutingQueryParams,
  GetAgentRoutingResponse,
} from "@workspace/api-zod";
import { resolveAgentIdentity, enqueueJob } from "../lib/jobs";
import {
  enqueueProvisionProjectJob,
  provisionPreviewDb,
  getRollingAverageMs,
} from "../lib/provisioning";
import { isContainerLayerConfigured } from "../lib/container";

// ── Health score — content-based analysis ─────────────────────────────────────
// Computes a 0–100 score by inspecting the actual generated HTML files for a
// project. Four weighted dimensions (25 pts each):
//   Accessibility  — alt text, ARIA roles, semantic elements
//   SEO            — <title>, meta description, <h1>
//   Performance    — external script count, lazy loading
//   Security       — absence of eval(), document.write(), raw innerHTML concat
//
// Returns 0 for projects with no files yet.

interface FileRow {
  path: string;
  content: string;
  mimeType: string;
}

function scoreHtml(files: FileRow[]): number {
  const htmlFiles = files.filter((f) => f.mimeType === "text/html" || f.path.endsWith(".html"));
  if (htmlFiles.length === 0) {
    // Has non-HTML files — give partial credit for structure
    return files.length > 0 ? 20 : 0;
  }
  const html = htmlFiles.map((f) => f.content).join("\n");

  // Accessibility (0-25)
  let accessibility = 0;
  if (/<img[^>]+alt\s*=/.test(html)) accessibility += 8;
  if (/aria-[a-z]+/.test(html)) accessibility += 9;
  if (/<(nav|main|header|footer|section|article)\b/.test(html)) accessibility += 8;

  // SEO (0-25)
  let seo = 0;
  if (/<title\b[^>]*>[^<]{2,}/.test(html)) seo += 10;
  if (/meta[^>]+name\s*=\s*["']description["']/.test(html)) seo += 10;
  if (/<h1\b/.test(html)) seo += 5;

  // Performance (0-25)
  const externalScripts = (html.match(/<script[^>]+src\s*=/g) ?? []).length;
  let performance = Math.max(0, 20 - externalScripts * 3);
  if (/loading\s*=\s*["']lazy["']/.test(html)) performance += 5;

  // Security (0-25) — deduct for dangerous patterns
  let security = 25;
  if (/\beval\s*\(/.test(html)) security -= 15;
  if (/document\.write\s*\(/.test(html)) security -= 5;
  if (/innerHTML\s*=\s*[^"'`][^;]*\+/.test(html)) security -= 5;
  security = Math.max(0, security);

  return Math.min(100, accessibility + seo + performance + security);
}

async function computeHealthScoreForProject(projectId: number): Promise<number> {
  const files = await db
    .select({
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return scoreHtml(files);
}

async function computeHealthScoresBatch(projectIds: number[]): Promise<Map<number, number>> {
  if (projectIds.length === 0) return new Map();
  const files = await db
    .select({
      projectId: projectFilesTable.projectId,
      path: projectFilesTable.path,
      content: projectFilesTable.content,
      mimeType: projectFilesTable.mimeType,
    })
    .from(projectFilesTable)
    .where(inArray(projectFilesTable.projectId, projectIds));

  const byProject = new Map<number, FileRow[]>();
  for (const f of files) {
    if (!byProject.has(f.projectId)) byProject.set(f.projectId, []);
    byProject.get(f.projectId)!.push(f);
  }

  const scores = new Map<number, number>();
  for (const id of projectIds) {
    scores.set(id, scoreHtml(byProject.get(id) ?? []));
  }
  return scores;
}

const router: IRouter = Router();

// Active projects only — soft-deleted rows are excluded from all user-facing queries.
const activeProjects = isNull(projectsTable.deletedAt);

router.get("/projects", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const userId = req.userId;
  const wsId = req.query.workspaceId ? parseInt(req.query.workspaceId as string, 10) : null;
  const mode = req.query.mode as string | undefined;
  const conditions: SQL[] = [eq(projectsTable.ownerId, userId), activeProjects];
  if (wsId && !isNaN(wsId)) conditions.push(eq(projectsTable.workspaceId, wsId));
  if (mode === "developer" || mode === "builder") {
    conditions.push(eq(projectsTable.projectMode, mode));
  }
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(...conditions))
    .orderBy(desc(projectsTable.updatedAt));
  const parsed = ListProjectsResponse.parse(rows);
  const scores = await computeHealthScoresBatch(rows.map((r) => r.id));
  const withScore = parsed.map((p) => ({
    ...p,
    healthScore: scores.get(p.id) ?? 0,
  }));
  res.json(withScore);
});

router.get("/projects/summary", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.ownerId, req.userId), activeProjects));

  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }

  const recentRows = [...rows]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 6);

  const summaryParsed = GetProjectsSummaryResponse.parse({
    total: rows.length,
    byStatus,
    byKind,
    recent: recentRows,
  });

  const recentScores = await computeHealthScoresBatch(recentRows.map((r) => r.id));
  res.json({
    ...summaryParsed,
    recent: summaryParsed.recent.map((p) => ({
      ...p,
      healthScore: recentScores.get(p.id) ?? 0,
    })),
  });
});

router.post("/projects", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    initialPrompt,
    brainstormContext,
    chipLabel,
    mode,
    builderMode: requestedBuilderMode,
    ...projectInput
  } = parsed.data;

  // Derive platform from kind
  const platformMap: Record<string, string> = {
    "mobile-ios": "ios",
    "mobile-android": "android",
    "mobile-cross": "cross",
  };
  const platform = platformMap[projectInput.kind] ?? "web";

  // Resolve stack — mobile projects don't use the stack system; web defaults to react-vite.
  const isMobilePlatform = platform !== "web";
  const resolvedStack: string = isMobilePlatform
    ? "react-vite"
    : (projectInput.stack ?? "react-vite");

  // projectFormat is only "react-vite" for the react-vite stack.
  // All other stacks (including nextjs, node-api, python-*) use the server's native tooling,
  // so they don't go through the browser WebContainer flow.
  const projectFormat =
    resolvedStack === "react-vite" && !isMobilePlatform ? "react-vite" : "static-html";

  const [project] = await db
    .insert(projectsTable)
    .values({
      ownerId: req.userId!,
      workspaceId: projectInput.workspaceId ?? null,
      name: projectInput.name,
      description: projectInput.description ?? null,
      kind: projectInput.kind,
      platform,
      projectFormat,
      stack: resolvedStack,
      // Task #738 — agentic projects get a real Fly container + Neon Postgres.
      // The frontend mode selector explicitly sets builderMode; default to
      // "agentic" when not provided (preserves backwards compatibility).
      builderMode: requestedBuilderMode ?? "agentic",
      // Start as 'provisioning' only when both Fly + Neon tokens are present.
      // Without them the background job degrades to 'idle' anyway, but only
      // after an async delay — setting 'idle' here avoids the workspace banner
      // flashing "Your project is being set up" before the job runs.
      provisioningStatus:
        (requestedBuilderMode ?? "agentic") === "agentic" &&
        isContainerLayerConfigured() &&
        Boolean(process.env.NEON_API_KEY)
          ? "provisioning"
          : "idle",
      lastTaskSummary: initialPrompt ? `Initial idea: ${initialPrompt.slice(0, 120)}` : null,
      chipLabel: chipLabel ?? null,
      projectMode: mode ?? "builder",
      requireCommandApproval: true,
    })
    .returning();

  if (!project) {
    res.status(500).json({ error: "Failed to create project" });
    return;
  }

  // Task #544: every new project gets a primary artifact mirroring its
  // kind/platform/format/stack. This preserves the "project owns ≥1 artifact"
  // invariant so resolveArtifactId() always finds a target and the artifact
  // tab strip auto-selects on load. The id is captured into primaryArtifactIdRef
  // and stamped onto every scaffold file insert below so artifact-scoped
  // replaceAll/writes work correctly from the very first build.
  const primaryArtifactIdRef: { id: number | null } = { id: null };
  {
    const { projectArtifactsTable } = await import("@workspace/db");
    const primaryKind = projectInput.kind;
    const slug =
      primaryKind === "web"
        ? "web"
        : primaryKind.startsWith("mobile")
          ? "mobile"
          : primaryKind || "app";
    const artifactName =
      primaryKind === "web"
        ? "Web app"
        : primaryKind.startsWith("mobile")
          ? "Mobile app"
          : slug[0]!.toUpperCase() + slug.slice(1);
    const [primaryArtifact] = await db
      .insert(projectArtifactsTable)
      .values({
        projectId: project.id,
        kind: primaryKind,
        platform,
        projectFormat,
        stack: resolvedStack,
        name: artifactName,
        slug,
        isPrimary: true,
        status: "draft",
      })
      .returning();
    if (primaryArtifact) primaryArtifactIdRef.id = primaryArtifact.id;
  }

  // Seed a minimal scaffold so the code editor shows a real file tree
  // immediately — before the first AI build runs.
  // Stack-specific scaffolds are handled below (node-api, python-flask, python-fastapi).
  if (resolvedStack === "node20" || resolvedStack === "node22") {
    const safeName = project.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const nodeVersion = resolvedStack === "node22" ? "22" : "20";
    const scaffoldFiles = [
      {
        path: "package.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            name: safeName,
            version: "1.0.0",
            main: "src/index.js",
            scripts: {
              start: "node src/index.js",
              dev: `node --watch src/index.js`,
            },
            engines: { node: `>=${nodeVersion}` },
            dependencies: {
              express: "^4.21.1",
              cors: "^2.8.5",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "src/index.js",
        mimeType: "application/javascript",
        content: `const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve the landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Example API route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', project: '${project.name}' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(\`${project.name} running on port \${PORT}\`);
});
`,
      },
      {
        path: "index.html",
        mimeType: "text/html",
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${project.name} — Node.js API" />
    <title>${project.name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
    <div class="text-center space-y-4">
      <h1 class="text-4xl font-bold">${project.name}</h1>
      <p class="text-gray-400">Node.js ${nodeVersion} / Express API — describe what to build in the chat.</p>
      <a href="/api/health" class="inline-block px-4 py-2 bg-blue-600 rounded-lg text-sm font-medium hover:bg-blue-700">
        GET /api/health
      </a>
    </div>
  </body>
</html>`,
      },
      {
        path: "README.md",
        mimeType: "text/plain",
        content: `# ${project.name}\n\nNode.js ${nodeVersion} / Express API.\n\n## Run locally\n\n\`\`\`\nnpm install\nnpm run dev\n\`\`\`\n`,
      },
    ];

    await db.insert(projectFilesTable).values(
      scaffoldFiles.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (resolvedStack === "python312") {
    const scaffoldFiles = [
      {
        path: "requirements.txt",
        mimeType: "text/plain",
        content: `flask>=3.1.0\nflask-cors>=5.0.0\npython-dotenv>=1.0.0\n`,
      },
      {
        path: "app.py",
        mimeType: "text/x-python",
        content: `import os
from flask import Flask, jsonify, send_file
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

PORT = int(os.environ.get("PORT", 3000))


@app.route("/")
def index():
    return send_file("index.html")


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "project": "${project.name}"})


@app.errorhandler(Exception)
def handle_exception(e):
    return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
`,
      },
      {
        path: "index.html",
        mimeType: "text/html",
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${project.name} — Python API" />
    <title>${project.name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
    <div class="text-center space-y-4">
      <h1 class="text-4xl font-bold">${project.name}</h1>
      <p class="text-gray-400">Python 3.12 / Flask API — describe what to build in the chat.</p>
      <a href="/api/health" class="inline-block px-4 py-2 bg-blue-600 rounded-lg text-sm font-medium hover:bg-blue-700">
        GET /api/health
      </a>
    </div>
  </body>
</html>`,
      },
      {
        path: ".env.example",
        mimeType: "text/plain",
        content: `# Copy this file to .env and fill in your values\n# MY_API_KEY=your_api_key_here\n`,
      },
      {
        path: "README.md",
        mimeType: "text/plain",
        content: `# ${project.name}\n\nPython 3.12 / Flask API.\n\n## Run locally\n\n\`\`\`\npip install -r requirements.txt\npython app.py\n\`\`\`\n`,
      },
    ];

    await db.insert(projectFilesTable).values(
      scaffoldFiles.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (projectFormat === "react-vite") {
    const safeName = project.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const scaffoldFiles = [
      {
        path: "package.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            name: safeName,
            private: true,
            version: "0.0.0",
            type: "module",
            scripts: {
              dev: "vite",
              build: "tsc && vite build",
              preview: "vite preview",
            },
            dependencies: {
              react: "^18.3.1",
              "react-dom": "^18.3.1",
            },
            devDependencies: {
              "@types/react": "^18.3.5",
              "@types/react-dom": "^18.3.0",
              "@vitejs/plugin-react": "^4.3.1",
              autoprefixer: "^10.4.20",
              postcss: "^8.4.45",
              tailwindcss: "^3.4.10",
              typescript: "^5.5.3",
              vite: "^5.4.2",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "index.html",
        mimeType: "text/html",
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${project.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
      },
      {
        path: "vite.config.ts",
        mimeType: "application/typescript",
        content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,
      },
      {
        path: "tailwind.config.js",
        mimeType: "application/javascript",
        content: `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
`,
      },
      {
        path: "postcss.config.js",
        mimeType: "application/javascript",
        content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`,
      },
      {
        path: "tsconfig.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            compilerOptions: {
              target: "ES2020",
              useDefineForClassFields: true,
              lib: ["ES2020", "DOM", "DOM.Iterable"],
              module: "ESNext",
              skipLibCheck: true,
              moduleResolution: "bundler",
              allowImportingTsExtensions: true,
              isolatedModules: true,
              moduleDetection: "force",
              noEmit: true,
              jsx: "react-jsx",
              strict: true,
              noUnusedLocals: true,
              noUnusedParameters: true,
              noFallthroughCasesInSwitch: true,
            },
            include: ["src"],
          },
          null,
          2,
        ),
      },
      {
        path: "src/main.tsx",
        mimeType: "application/typescript",
        content: `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`,
      },
      {
        path: "src/App.tsx",
        mimeType: "application/typescript",
        content: `export default function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">${project.name}</h1>
        <p className="text-gray-500">Your app is ready. Describe what to build in the chat.</p>
      </div>
    </div>
  )
}
`,
      },
      {
        path: "src/index.css",
        mimeType: "text/css",
        content: `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
      },
    ];

    await db.insert(projectFilesTable).values(
      scaffoldFiles.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (resolvedStack === "nextjs") {
    const safeName = project.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const nextjsScaffold = [
      {
        path: "package.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            name: safeName,
            version: "0.1.0",
            private: true,
            scripts: { dev: "next dev -p 3000", build: "next build", start: "next start -p 3000" },
            dependencies: {
              next: "14.2.5",
              react: "^18.3.1",
              "react-dom": "^18.3.1",
              "lucide-react": "^0.447.0",
              clsx: "^2.1.1",
              "tailwind-merge": "^2.5.3",
            },
            devDependencies: {
              "@types/node": "^22.0.0",
              "@types/react": "^18.3.11",
              "@types/react-dom": "^18.3.1",
              autoprefixer: "^10.4.20",
              postcss: "^8.4.47",
              tailwindcss: "^3.4.14",
              typescript: "^5.6.3",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "next.config.js",
        mimeType: "application/javascript",
        content: `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true }
module.exports = nextConfig
`,
      },
      {
        path: "tailwind.config.js",
        mimeType: "application/javascript",
        content: `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
}
`,
      },
      {
        path: "postcss.config.js",
        mimeType: "application/javascript",
        content: `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } }
`,
      },
      {
        path: "tsconfig.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            compilerOptions: {
              target: "ES2017",
              lib: ["dom", "dom.iterable", "esnext"],
              allowJs: true,
              skipLibCheck: true,
              strict: true,
              noEmit: true,
              esModuleInterop: true,
              module: "esnext",
              moduleResolution: "bundler",
              resolveJsonModule: true,
              isolatedModules: true,
              jsx: "preserve",
              incremental: true,
              plugins: [{ name: "next" }],
              paths: { "@/*": ["./src/*"] },
            },
            include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
            exclude: ["node_modules"],
          },
          null,
          2,
        ),
      },
      {
        path: "src/app/globals.css",
        mimeType: "text/css",
        content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`,
      },
      {
        path: "src/app/layout.tsx",
        mimeType: "application/typescript",
        content: `import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '${project.name}',
  description: 'Built with MustaFlow AI',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`,
      },
      {
        path: "src/app/page.tsx",
        mimeType: "application/typescript",
        content: `export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">${project.name}</h1>
        <p className="text-gray-500">Your Next.js app is ready. Describe what to build in the chat.</p>
      </div>
    </main>
  )
}
`,
      },
    ];
    await db.insert(projectFilesTable).values(
      nextjsScaffold.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (resolvedStack === "node-api") {
    const safeName = project.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const nodeApiScaffold = [
      {
        path: "package.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            name: safeName,
            version: "1.0.0",
            private: true,
            scripts: { dev: "tsx watch src/index.ts", build: "tsc", start: "node dist/index.js" },
            dependencies: {
              express: "^4.21.0",
              cors: "^2.8.5",
              zod: "^3.23.8",
              dotenv: "^16.4.5",
            },
            devDependencies: {
              "@types/express": "^4.17.21",
              "@types/cors": "^2.8.17",
              "@types/node": "^22.0.0",
              tsx: "^4.19.1",
              typescript: "^5.6.3",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "tsconfig.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "commonjs",
              lib: ["ES2022"],
              outDir: "dist",
              rootDir: "src",
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
              resolveJsonModule: true,
            },
            include: ["src"],
            exclude: ["node_modules", "dist"],
          },
          null,
          2,
        ),
      },
      {
        path: "src/index.ts",
        mimeType: "application/typescript",
        content: `import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { router } from './routes/index'

const app = express()
const PORT = process.env.PORT ?? 3000

app.use(cors())
app.use(express.json())
app.use('/api', router)

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', project: '${project.name}' })
})

app.listen(PORT, () => {
  console.log(\`${project.name} API listening on port \${PORT}\`)
})
`,
      },
      {
        path: "src/routes/index.ts",
        mimeType: "application/typescript",
        content: `import { Router } from 'express'

export const router = Router()

router.get('/', (_req, res) => {
  res.json({ message: 'Welcome to the ${project.name} API' })
})
`,
      },
      {
        path: ".env.example",
        mimeType: "text/plain",
        content: `PORT=3000
# Add your environment variables here
`,
      },
    ];
    await db.insert(projectFilesTable).values(
      nodeApiScaffold.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (resolvedStack === "python-flask") {
    const flaskScaffold = [
      {
        path: "requirements.txt",
        mimeType: "text/plain",
        content: `Flask==3.0.3\nflask-cors==4.0.1\npython-dotenv==1.0.1\n`,
      },
      {
        path: "app.py",
        mimeType: "text/x-python",
        content: `from __future__ import annotations

import os
from flask import Flask, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app)

    @app.get("/healthz")
    def healthz():
        return jsonify({"status": "ok", "project": "${project.name}"})

    @app.get("/api")
    def index():
        return jsonify({"message": "Welcome to the ${project.name} API"})

    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app = create_app()
    app.run(host="0.0.0.0", port=port, debug=True)
`,
      },
      {
        path: ".env.example",
        mimeType: "text/plain",
        content: `PORT=5000\n# Add your environment variables here\n`,
      },
    ];
    await db.insert(projectFilesTable).values(
      flaskScaffold.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (resolvedStack === "python-fastapi") {
    const fastapiScaffold = [
      {
        path: "requirements.txt",
        mimeType: "text/plain",
        content: `fastapi==0.115.0\nuvicorn[standard]==0.30.6\npydantic==2.8.2\npython-dotenv==1.0.1\n`,
      },
      {
        path: "main.py",
        mimeType: "text/x-python",
        content: `from __future__ import annotations

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="${project.name}", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "project": "${project.name}"}


@app.get("/api")
async def root() -> dict[str, str]:
    return {"message": "Welcome to the ${project.name} API"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
`,
      },
      {
        path: ".env.example",
        mimeType: "text/plain",
        content: `PORT=8000\n# Add your environment variables here\n`,
      },
    ];
    await db.insert(projectFilesTable).values(
      fastapiScaffold.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  } else if (isMobilePlatform) {
    const safeName =
      project.name
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
        .slice(0, 30) || "app";
    const mobileScaffold = [
      {
        path: "app.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            expo: {
              name: project.name,
              slug: safeName,
              version: "1.0.0",
              scheme: safeName,
              platforms: ["ios", "android", "web"],
              ios: { bundleIdentifier: `com.mustaflow.${safeName}` },
              android: { package: `com.mustaflow.${safeName}` },
            },
          },
          null,
          2,
        ),
      },
      {
        path: "package.json",
        mimeType: "application/json",
        content: JSON.stringify(
          {
            name: safeName,
            version: "1.0.0",
            private: true,
            main: "expo-router/entry",
            scripts: {
              start: "expo start",
              android: "expo start --android",
              ios: "expo start --ios",
              web: "expo start --web",
            },
            dependencies: {
              expo: "~52.0.0",
              "expo-router": "~3.5.0",
              "expo-status-bar": "~2.0.0",
              nativewind: "~4.0.1",
              "react-native-safe-area-context": "4.12.0",
              "react-native-screens": "~4.4.0",
              "@expo/metro-runtime": "~4.0.0",
              "@react-navigation/native": "^6.1.18",
              react: "18.3.1",
              "react-dom": "18.3.1",
              "react-native": "0.76.7",
              tailwindcss: "^3.4.0",
            },
            devDependencies: {
              "@babel/core": "^7.24.0",
              "@types/react": "~18.3.12",
              "@types/react-native": "~0.76.0",
              typescript: "~5.3.3",
            },
          },
          null,
          2,
        ),
      },
      {
        path: "babel.config.js",
        mimeType: "application/javascript",
        content: `module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['nativewind/babel'],
  };
};
`,
      },
      {
        path: "tailwind.config.js",
        mimeType: "application/javascript",
        content: `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
`,
      },
      {
        path: "app/_layout.tsx",
        mimeType: "application/typescript",
        content: `import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
`,
      },
      {
        path: "app/index.tsx",
        mimeType: "application/typescript",
        content: `import { View, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  return (
    <SafeAreaView className="flex-1 bg-gray-950">
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <Text className="text-3xl font-bold text-white text-center">
          ${project.name}
        </Text>
        <Text className="text-gray-400 text-center text-base">
          Describe your app in the AI Builder below and press Send.
        </Text>
      </View>
    </SafeAreaView>
  );
}
`,
      },
      {
        path: "index.html",
        mimeType: "text/html",
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${project.name}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="min-h-screen bg-gray-950 text-white flex items-center justify-center">
    <div class="max-w-sm mx-auto text-center space-y-4 px-6">
      <div class="w-20 h-20 bg-indigo-600 rounded-2xl mx-auto flex items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a1 1 0 001-1v-1a7 7 0 00-14 0v1a1 1 0 001 1zM12 3a4 4 0 100 8 4 4 0 000-8z" />
        </svg>
      </div>
      <h1 class="text-2xl font-bold">${project.name}</h1>
      <p class="text-gray-400 text-sm">
        Describe your mobile app in the AI Builder to generate the full Expo / React Native code.
      </p>
      <div class="text-xs text-gray-600 border border-gray-800 rounded-lg px-3 py-2">
        Mobile preview (web simulation)
      </div>
    </div>
  </body>
</html>`,
      },
    ];

    await db.insert(projectFilesTable).values(
      mobileScaffold.map((f) => ({
        projectId: project.id,
        artifactId: primaryArtifactIdRef.id,
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  }

  if (initialPrompt && initialPrompt.trim().length > 0) {
    // Inject brainstorm context into the stored user message so the AI sees
    // the full brainstorm conversation when the first build runs — same format
    // as the workspace composer path (messages.ts userPromptWithContext).
    const hasBrainstormContext = Array.isArray(brainstormContext) && brainstormContext.length > 0;
    let initialPromptWithContext = initialPrompt;
    if (hasBrainstormContext) {
      const turns = (brainstormContext as Array<{ role: string; content: string }>)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n");
      initialPromptWithContext =
        `${initialPrompt}\n\n` +
        `[BRAINSTORM CONTEXT — conversation that shaped this request; use it to understand ` +
        `the user's intent, priorities, and edge cases]\n${turns}\n[END BRAINSTORM CONTEXT]`;
    }
    // Store the user's prompt as the first chat message.
    await db.insert(chatMessagesTable).values({
      projectId: project.id,
      role: "user",
      content: initialPromptWithContext,
      agentMode: "eco",
      planMode: false,
    });

    // Kick off the initial build immediately — mirrors the background-build path
    // in POST /api/projects/:id/messages so the pipeline actually runs instead of
    // returning a canned greeting that leaves the project permanently unbuilt.
    // Agent Zero v2: initial builds execute on Main Agent so preview receives
    // committed project_files immediately instead of hidden staging output.
    const resolvedIdentity = resolveAgentIdentity(initialPrompt, false, false, false, false);
    const [initialTask] = await db
      .insert(agentTasksTable)
      .values({
        projectId: project.id,
        title: `Build: ${initialPrompt.slice(0, 60)}`,
        kind: "main",
        status: "planning",
        prompt: initialPrompt,
        agentIdentity: resolvedIdentity,
        runMode: "foreground",
        taskAgentMode: "eco",
        hasBrainstormContext,
        brainstormTurnCount: hasBrainstormContext
          ? (brainstormContext as Array<{ role: string; content: string }>).length
          : null,
      })
      .returning();

    if (initialTask) {
      // Dispatch the build job asynchronously so the HTTP response returns
      // immediately while the build runs in the background queue.
      enqueueJob({
        taskId: initialTask.id,
        projectId: project.id,
        kind: "build",
        userPrompt: initialPromptWithContext,
        agentMode: "eco",
        agentIdentity: resolvedIdentity,
        conversationHistory: [],
      });

      // Optimistic assistant message so the chat shows activity right away.
      await db.insert(chatMessagesTable).values({
        projectId: project.id,
        role: "assistant",
        content:
          "On it — building your app now. This usually takes 30–60 seconds. The Preview tab will update when it's ready.",
        agentMode: "eco",
        planMode: false,
      });
    }
  }

  // Task #738 — kick off background provisioning for agentic projects. Only
  // enqueue when the project is actually going to get a real server + DB;
  // static-legacy projects remain idle and never incur provisioning costs.
  // Fire and forget: the response returns immediately and the workspace UI
  // polls `provisioningStatus` to surface progress.
  // Only enqueue provisioning when tokens are present; otherwise the
  // project was already stamped 'idle' above and no job is needed.
  if (
    project.builderMode === "agentic" &&
    isContainerLayerConfigured() &&
    process.env.NEON_API_KEY
  ) {
    enqueueProvisionProjectJob(project.id);
  }

  res.status(201).json(GetProjectResponse.parse(project));
});

// ── GET /api/projects/:id/provision/status ────────────────────────────────────
// Task #738 — dedicated, lightweight endpoint the workspace header polls for
// the provisioning lifecycle (`provisioning → ready → hibernated → error`).
// Returning just the provisioning fields keeps the polled payload small and
// independent from the much larger full-project response.
router.get(
  "/projects/:id/provision/status",
  requireProjectAccess,
  async (req: import("express").Request, res: import("express").Response): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [row] = await db
      .select({
        builderMode: projectsTable.builderMode,
        provisioningStatus: projectsTable.provisioningStatus,
        provisioningError: projectsTable.provisioningError,
        provisioningStep: projectsTable.provisioningStep,
        provisioningStartedAt: projectsTable.provisioningStartedAt,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!row) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Compute estimated seconds remaining based on rolling average minus elapsed time.
    let estimatedSecondsRemaining: number | null = null;
    if (row.provisioningStatus === "provisioning" && row.provisioningStartedAt) {
      const elapsedMs = Date.now() - new Date(row.provisioningStartedAt).getTime();
      const remainingMs = getRollingAverageMs() - elapsedMs;
      estimatedSecondsRemaining = Math.max(0, Math.round(remainingMs / 1000));
    }

    res.json({
      builderMode: row.builderMode,
      provisioningStatus: row.provisioningStatus,
      provisioningError: row.provisioningError,
      provisioningStep: row.provisioningStep ?? null,
      estimatedSecondsRemaining,
      containerStatus: row.containerStatus,
    });
  },
);

// ── POST /api/projects/:id/provision/retry ────────────────────────────────────
// Task #738 — when auto-provisioning fails (e.g. Fly outage, Neon quota), the
// workspace header surfaces a "Retry" action. This route re-runs the
// idempotent provisioning pipeline. Only the project owner can retry.
router.post(
  "/projects/:id/provision/retry",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [project] = await db
      .select({
        id: projectsTable.id,
        provisioningStatus: projectsTable.provisioningStatus,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.provisioningStatus === "provisioning") {
      res.status(409).json({ error: "Provisioning is already in progress." });
      return;
    }
    await db
      .update(projectsTable)
      .set({ provisioningStatus: "provisioning", provisioningError: null })
      .where(eq(projectsTable.id, projectId));
    enqueueProvisionProjectJob(projectId);
    res.json({ provisioningStatus: "provisioning" });
  },
);

// ── POST /api/projects/:id/preview-db/provision ───────────────────────────────
// Task #767 — provision a dedicated Neon Postgres DB for the preview environment.
// Idempotent: safe to call multiple times — re-calls when previewDbStatus='ready' are no-ops.
router.post(
  "/projects/:id/preview-db/provision",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [project] = await db
      .select({ id: projectsTable.id, previewDbStatus: projectsTable.previewDbStatus })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.previewDbStatus === "provisioning") {
      res.status(409).json({ error: "Preview DB provisioning is already in progress." });
      return;
    }
    // Fire-and-forget — the front-end polls project status to see when it changes to "ready".
    setImmediate(() => {
      void provisionPreviewDb(projectId);
    });
    res.json({ previewDbStatus: "provisioning" });
  },
);

// ── Trash / soft-delete recovery ──────────────────────────────────────────────
// Soft-deleted projects (deletedAt IS NOT NULL) remain in the DB for a 30-day
// recovery window. After 30 days they're still retained server-side (no purger
// runs in v1) but the Trash UI hides them as "expired" so users don't expect
// recovery.
//
// IMPORTANT: these routes are declared BEFORE "/projects/:id" so the literal
// "/projects/trash" path is not shadowed by the parameterized route. Likewise
// "/projects/:id/restore" must be declared before any conflicting handlers.
const TRASH_RECOVERY_DAYS = 30;

router.get("/projects/trash", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const userId = req.userId;
  const rows = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.ownerId, userId),
        sql`${projectsTable.deletedAt} IS NOT NULL`,
        sql`${projectsTable.deletedAt} > now() - interval '${sql.raw(String(TRASH_RECOVERY_DAYS))} days'`,
      ),
    )
    .orderBy(desc(projectsTable.deletedAt));
  const parsed = ListProjectsResponse.parse(rows);
  res.json(parsed);
});

router.post("/projects/:id/restore", async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  // Manual ownership check — requireProjectOwnership filters by activeProjects
  // (deletedAt IS NULL) so it would 404 every trashed project.
  const [project] = await db
    .update(projectsTable)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(projectsTable.id, params.data.id),
        eq(projectsTable.ownerId, userId),
        sql`${projectsTable.deletedAt} IS NOT NULL`,
        sql`${projectsTable.deletedAt} > now() - interval '${sql.raw(String(TRASH_RECOVERY_DAYS))} days'`,
      ),
    )
    .returning();
  if (!project) {
    res
      .status(404)
      .json({ error: "Project not found, not owned by you, or recovery window expired" });
    return;
  }
  res.json(GetProjectResponse.parse(project));
});

router.get("/projects/:id", requireProjectAccess("viewer"), async (req, res): Promise<void> => {
  const params = GetProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), activeProjects));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const parsed = GetProjectResponse.parse(project);
  const healthScore = await computeHealthScoreForProject(project.id);
  res.json({ ...parsed, healthScore });
});

router.patch("/projects/:id", requireProjectAccess("member"), async (req, res): Promise<void> => {
  const params = UpdateProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Permissive policy strictness is admin-only: it relaxes the egress
  // allowlist on pkg_install (private registries) and is therefore reserved
  // for internal/trusted projects. Owners can freely choose between `safe`
  // and `standard`.
  const requestedStrictness = (parsed.data as { policyStrictness?: string }).policyStrictness;
  if (requestedStrictness === "permissive") {
    const { getAuth } = await import("@clerk/express");
    const { isAdminUser } = await import("../lib/adminAuth");
    const userId = getAuth(req).userId;
    const allowed = userId ? await isAdminUser(userId) : false;
    if (!allowed) {
      res.status(403).json({
        error: "Only admins can enable 'permissive' policy strictness.",
      });
      return;
    }
  }

  // When upgrading to agentic mode, automatically set provisioningStatus to
  // "provisioning" so the badge appears immediately without a refetch race.
  const requestedBuilderMode = (parsed.data as { builderMode?: string }).builderMode;
  const updatePayload =
    requestedBuilderMode === "agentic"
      ? { ...parsed.data, provisioningStatus: "provisioning", updatedAt: sql`now()` }
      : { ...parsed.data, updatedAt: sql`now()` };

  // Fetch current project so we can detect the static-legacy → agentic transition.
  const [beforeUpdate] = await db
    .select({ builderMode: projectsTable.builderMode })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), activeProjects));

  const [project] = await db
    .update(projectsTable)
    .set(updatePayload)
    .where(and(eq(projectsTable.id, params.data.id), activeProjects))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Trigger provisioning if the project was just upgraded to agentic mode.
  if (requestedBuilderMode === "agentic" && beforeUpdate?.builderMode !== "agentic") {
    enqueueProvisionProjectJob(project.id);
  }

  res.json(UpdateProjectResponse.parse(project));
});

// Soft delete — sets deletedAt instead of removing the row.
// All project-scoped data (files, secrets, versions, etc.) is retained for
// potential recovery but the project disappears from all user-facing queries.
router.delete("/projects/:id", requireProjectOwnership, async (req, res): Promise<void> => {
  const params = DeleteProjectParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  // Fetch project name before soft-delete so we can log a meaningful summary
  const [existing] = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), activeProjects));

  if (!existing) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Log delete activity before the row is soft-deleted
  try {
    await db.insert(projectActivityTable).values({
      projectId: existing.id,
      actorId: req.userId ?? null,
      actorName: null,
      eventType: "delete",
      summary: `Project "${existing.name}" was deleted`,
      metadata: { projectName: existing.name },
    });
  } catch {
    // non-fatal — proceed with the delete regardless
  }

  const [project] = await db
    .update(projectsTable)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(projectsTable.id, params.data.id), activeProjects))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.status(200).json({ deleted: true, projectId: project.id });
});

// ── GET /api/projects/:id/container-health ────────────────────────────────────
// Lightweight endpoint the workspace header polls every 30 s to display a live
// container health indicator (green = awake, amber = hibernated, red = unreachable).
// Reads from the DB rather than making a live Fly call so it stays fast.
router.get(
  "/projects/:id/container-health",
  requireProjectAccess("viewer"),
  async (req: import("express").Request, res: import("express").Response): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const [row] = await db
      .select({
        builderMode: projectsTable.builderMode,
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
        provisioningStatus: projectsTable.provisioningStatus,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!row) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    // Map stored containerStatus to the three indicator states
    const raw = row.containerStatus ?? "stopped";
    const health: "awake" | "hibernated" | "unreachable" | "unknown" =
      raw === "running"
        ? "awake"
        : raw === "hibernated" || raw === "stopped"
          ? "hibernated"
          : raw === "error"
            ? "unreachable"
            : "unknown";
    res.json({
      builderMode: row.builderMode,
      containerId: row.containerId,
      containerStatus: raw,
      health,
      provisioningStatus: row.provisioningStatus,
    });
  },
);

// ── Agent routing hint ─────────────────────────────────────────────────────────
// Returns the recommended visible executor for a given prompt + project state.
// Used by the frontend composer for lightweight guidance.
router.get(
  "/projects/:id/agent-routing",
  requireProjectAccess("viewer"),
  async (req, res): Promise<void> => {
    const params = GetAgentRoutingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const queryParams = GetAgentRoutingQueryParams.safeParse(req.query);
    if (!queryParams.success) {
      res.status(400).json({ error: queryParams.error.message });
      return;
    }

    const [fileCount] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, params.data.id));
    const hasFiles = (fileCount?.c ?? 0) > 0;

    const prompt = queryParams.data.prompt ?? "";
    const agentIdentity = resolveAgentIdentity(prompt, hasFiles, false, false, false);

    const reasonMap: Record<string, string> = {
      planning: "Plan first — Agent Zero will create a plan before building",
      task: "Legacy staged-review mode is no longer used for new work",
      main: hasFiles
        ? "Main Agent will apply changes directly and update preview"
        : "Main Agent will build the first version and update preview",
    };

    res.json(
      GetAgentRoutingResponse.parse({
        agentIdentity,
        reason: reasonMap[agentIdentity] ?? "",
      }),
    );
  },
);

// Used by activity feed - keep references so unused-import linter doesn't trip
void agentTasksTable;

export default router;
