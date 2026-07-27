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
    pathname === "/projects" ||
    pathname.startsWith("/projects/") ||
    pathname.startsWith("/assets/")
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
      if (isBuilderIsolationPath(request.url)) {
        for (const [name, value] of Object.entries(
          crossOriginIsolationHeaders,
        )) {
          response.setHeader(name, value);
        }
      }
      next();
    });
  },
};

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
      // NOTE: No custom `manualChunks` here on purpose. Hand-splitting
      // interdependent vendor libraries (recharts/d3, remark/rehype, xyflow, etc.)
      // across separate chunks creates circular imports between chunks, which
      // surface at runtime as "Cannot access 'X' before initialization" (TDZ)
      // errors that crash the whole app before React mounts. Rollup's default
      // chunking co-locates circularly-dependent modules and guarantees correct
      // init order. Route-level code splitting via lazy() imports is unaffected.
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
