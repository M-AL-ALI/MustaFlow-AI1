import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const PUBLIC_STATIC_ASSET_PATTERN =
  /^\/(?!@)[^?#]+\.(?:avif|bmp|eot|gif|ico|jpe?g|otf|png|svg|ttf|webp|woff2?)(?:[?#].*)?$/iu;
const PUBLIC_STATIC_ASSET_ID = "\0vitest-public-static-asset:";

export default defineConfig({
  plugins: [
    {
      name: "vitest-public-static-assets",
      enforce: "pre",
      resolveId(source) {
        if (PUBLIC_STATIC_ASSET_PATTERN.test(source)) {
          return `${PUBLIC_STATIC_ASSET_ID}${source}`;
        }
        return null;
      },
      load(id) {
        if (!id.startsWith(PUBLIC_STATIC_ASSET_ID)) return null;
        return `export default ${JSON.stringify(id.slice(PUBLIC_STATIC_ASSET_ID.length))};`;
      },
    },
    react(),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
