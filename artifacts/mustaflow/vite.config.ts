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

const crossOriginIsolationHeaders = {
  // Required for SharedArrayBuffer (WebContainers).
  // "credentialless" allows cross-origin resources without opt-in CORP headers,
  // which is necessary for Clerk and other third-party scripts to keep working.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

function isBuilderIsolationPath(url = ""): boolean {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  return (
    pathname === "/projects" || pathname.startsWith("/projects/") || pathname.startsWith("/assets/")
  );
}

const builderIsolationPreviewHeaders = {
  name: "builder-isolation-preview-headers",
  configurePreviewServer(server: {
    middlewares: {
      use: (
        middleware: (
          request: { url?: string },
          response: { setHeader: (name: string, value: string) => void },
          next: () => void,
        ) => void,
      ) => void;
    };
  }) {
    server.middlewares.use((request, response, next) => {
      // Wave 5.1 local verification disables these headers so the built
      // production bundle must become isolated through builder-coi-sw.js alone.
      const previewHeadersEnabled = process.env.BUILDER_PREVIEW_ISOLATION_HEADERS !== "0";
      if (previewHeadersEnabled && isBuilderIsolationPath(request.url)) {
        for (const [name, value] of Object.entries(crossOriginIsolationHeaders)) {
          response.setHeader(name, value);
        }
      }
      next();
    });
  },
};

function boundedWorkspaceSharedChunk(id: string): string | undefined {
  const normalized = id.replaceAll("\\", "/");

  // The authenticated workspace imports many small Lucide leaf modules and UI
  // primitives. Leaving each shared leaf as its own chunk creates a burst large
  // enough for production artifact serving to rate-limit module requests. These
  // two acyclic families are safe to coalesce without hand-splitting the larger
  // vendor graphs called out below.
  if (
    normalized.includes("/node_modules/lucide-react/dist/esm/icons/") ||
    normalized.endsWith("/node_modules/lucide-react/dist/esm/createLucideIcon.js") ||
    normalized.endsWith("/node_modules/lucide-react/dist/esm/shared/src/utils.js")
  ) {
    return "workspace-icons";
  }

  if (normalized.includes("/artifacts/mustaflow/src/components/ui/")) {
    return "workspace-ui";
  }

  return undefined;
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    runtimeErrorOverlay(),
    builderIsolationPreviewHeaders,
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
    // Emit the Vite asset manifest so check-bundle-size.mjs can analyse the
    // transitive import graph for each entry.
    manifest: true,
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
        manualChunks: boundedWorkspaceSharedChunk,
      },
      // Keep Rollup's default chunking for interdependent vendor libraries
      // (recharts/d3, remark/rehype, xyflow, etc.). Hand-splitting those graphs
      // creates circular cross-chunk imports and TDZ crashes. The function above
      // coalesces only the workspace's acyclic icon leaves and UI primitives to
      // bound production request fan-out; route-level lazy chunks stay intact.
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
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    headers: {},
    // Vite preview serves the production bundle during local release checks.
    // The plugin above matches Replit's production path-scoped headers.
  },
});
