import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  chatMessagesTable,
  agentTasksTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
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
import { buildInitialAssistantMessage } from "../lib/ai";
import { resolveAgentIdentity } from "../lib/jobs";

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
  const userId = req.userId ?? "demo-user";
  const wsId = req.query.workspaceId ? parseInt(req.query.workspaceId as string, 10) : null;
  const conditions: SQL[] = [eq(projectsTable.ownerId, userId), activeProjects];
  if (wsId && !isNaN(wsId)) conditions.push(eq(projectsTable.workspaceId, wsId));
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
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.ownerId, req.userId ?? "demo-user"), activeProjects));

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
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { initialPrompt, ...projectInput } = parsed.data;

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
      ownerId: req.userId ?? "demo-user",
      workspaceId: projectInput.workspaceId ?? null,
      name: projectInput.name,
      description: projectInput.description ?? null,
      kind: projectInput.kind,
      platform,
      projectFormat,
      stack: resolvedStack,
      lastTaskSummary: initialPrompt ? `Initial idea: ${initialPrompt.slice(0, 120)}` : null,
    })
    .returning();

  if (!project) {
    res.status(500).json({ error: "Failed to create project" });
    return;
  }

  // Seed a minimal scaffold so the code editor shows a real file tree
  // immediately — before the first AI build runs.
  // Stack-specific scaffolds are handled below (node-api, python-flask, python-fastapi).
  if (projectFormat === "react-vite") {
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
        path: f.path,
        content: f.content,
        mimeType: f.mimeType,
      })),
    );
  }

  if (initialPrompt && initialPrompt.trim().length > 0) {
    await db.insert(chatMessagesTable).values({
      projectId: project.id,
      role: "user",
      content: initialPrompt,
      agentMode: "eco",
      planMode: false,
    });

    const greeting = buildInitialAssistantMessage(project.name, initialPrompt);
    await db.insert(chatMessagesTable).values({
      projectId: project.id,
      role: "assistant",
      content: greeting,
      agentMode: "eco",
      planMode: false,
    });
  }

  res.status(201).json(GetProjectResponse.parse(project));
});

router.get("/projects/:id", requireProjectOwnership, async (req, res): Promise<void> => {
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

router.patch("/projects/:id", requireProjectOwnership, async (req, res): Promise<void> => {
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

  const [project] = await db
    .update(projectsTable)
    .set({ ...parsed.data, updatedAt: sql`now()` })
    .where(and(eq(projectsTable.id, params.data.id), activeProjects))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
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

// ── Agent routing hint ─────────────────────────────────────────────────────────
// Returns the recommended agentIdentity for a given prompt + project state.
// Used by the frontend composer to show a live "Recommended: X Agent" badge.
router.get(
  "/projects/:id/agent-routing",
  requireProjectOwnership,
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
      planning: "Plan mode — Planning Agent investigates first then builds a structured plan",
      task:
        prompt.length > 120
          ? "Long prompt — Task Agent will stage changes for your review before applying"
          : !hasFiles
            ? "New project — Task Agent will stage the initial build for review"
            : "Task Agent will stage changes for your review before applying",
      main: "Short edit on existing project — Main Agent applies changes directly",
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
