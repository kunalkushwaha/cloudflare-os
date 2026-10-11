import { defineConfig } from "vitest/config";

/**
 * Pure logic only for now; the hub and gatekeeper suites move to a workerd pool with the
 * integration tests. No workerd pool yet, so no assert-workerd setup here.
 */
export default defineConfig({
  test: {
    // Pure logic only; `*.worker.test.ts` files run in the workerd pool (vitest.worker.config.ts).
    include: ["__tests__/*.test.ts"],
    exclude: ["**/*.worker.test.ts", "**/node_modules/**", "**/dist/**"],
  },
});