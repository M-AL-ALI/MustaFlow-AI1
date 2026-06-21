import { defineConfig } from "vitest/config";

// Minimal node-environment harness scoped to pure-logic lib modules (no React
// Native imports). Component/UI code is not unit-tested here; this covers
// security-critical helpers such as the URL SSRF guard (lib/safe-url.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
