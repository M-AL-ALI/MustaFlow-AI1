import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error("BASE_PATH environment variable is required but was not provided.");
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) => m.devBanner()),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Warn when any individual chunk exceeds 800 kB (uncompressed).
    // The overall public entry must stay below Google's 2 MB rendering limit.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        // Full authenticated app — loads Clerk, workspace context, builder, etc.
        index: path.resolve(import.meta.dirname, "index.html"),
        // Lightweight public entry — no Clerk, smaller initial JS for crawlers.
        public: path.resolve(import.meta.dirname, "public.html"),
      },
      output: {
        manualChunks(id) {
          // Core React runtime — loaded on every route
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react-runtime";
          }
          // Clerk auth — needed for most routes but not the raw bundle
          if (id.includes("node_modules/@clerk/")) {
            return "clerk";
          }
          // Monaco editor — only used in the project workspace
          if (
            id.includes("node_modules/@monaco-editor/") ||
            id.includes("node_modules/monaco-editor/")
          ) {
            return "monaco";
          }
          // XYFlow / canvas — only used in the builder canvas tab
          if (id.includes("node_modules/@xyflow/") || id.includes("node_modules/@dagrejs/")) {
            return "canvas-libs";
          }
          // Heavy document generation libs — only used in export flows
          if (
            id.includes("node_modules/docx/") ||
            id.includes("node_modules/exceljs/") ||
            id.includes("node_modules/pptxgenjs/") ||
            id.includes("node_modules/html2canvas/")
          ) {
            return "doc-export";
          }
          // Stripe — only used in billing page
          if (id.includes("node_modules/@stripe/")) {
            return "stripe";
          }
          // Recharts + chart deps — only used in reporting/usage pages
          if (id.includes("node_modules/recharts/") || id.includes("node_modules/d3-")) {
            return "charts";
          }
          // WebContainers — only used in agentic builder
          if (id.includes("node_modules/@webcontainer/")) {
            return "webcontainer";
          }
          // Sentry — error reporting, deferred
          if (id.includes("node_modules/@sentry/")) {
            return "sentry";
          }
          // Framer Motion — animations, only loaded where used
          if (id.includes("node_modules/framer-motion/")) {
            return "framer-motion";
          }
          // React Markdown + remark/rehype pipeline
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/remark") ||
            id.includes("node_modules/rehype") ||
            id.includes("node_modules/unified/") ||
            id.includes("node_modules/mdast") ||
            id.includes("node_modules/hast") ||
            id.includes("node_modules/micromark") ||
            id.includes("node_modules/vfile")
          ) {
            return "markdown";
          }
          // highlight.js — syntax highlighting in the editor / markdown
          if (id.includes("node_modules/highlight.js/")) {
            return "highlight";
          }
          // All other node_modules — shared vendor chunk
          if (id.includes("node_modules/")) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    headers: {
      // Required for SharedArrayBuffer (WebContainers).
      // "credentialless" allows cross-origin resources without opt-in CORP headers,
      // which is necessary for Clerk and other third-party scripts to keep working.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
