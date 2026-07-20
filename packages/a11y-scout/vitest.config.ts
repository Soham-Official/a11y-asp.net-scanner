import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Source-level tests only; never the compiled output.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Browser-driven keyboard tests launch Chromium and walk the page; give
    // them headroom over the default 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
