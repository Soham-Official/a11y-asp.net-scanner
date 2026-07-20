import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Source-level tests only; never the compiled output.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Parity tests launch a real WebdriverIO Chrome session (auto-managed
    // driver) plus a Playwright Chromium for comparison — both need headroom
    // over vitest's 5s default, including one-time driver download on first run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
