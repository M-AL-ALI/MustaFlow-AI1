import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@cloudflare/sandbox": fileURLToPath(
        new URL("./test/cloudflare-sandbox-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
  },
});
