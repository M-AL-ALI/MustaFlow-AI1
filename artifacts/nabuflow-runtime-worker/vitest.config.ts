import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-stub.ts", import.meta.url),
      ),
      "@cloudflare/sandbox": fileURLToPath(
        new URL("./test/cloudflare-sandbox-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
  },
});
