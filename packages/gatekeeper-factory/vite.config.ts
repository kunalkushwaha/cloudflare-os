// Vite+ per-package settings. The two test passes stay separate commands so the worker suite can
// replay when only the pure-logic suite's inputs moved.
import { defineConfig } from "vite-plus";
import { vitestTask } from "@gadgets/scripts/vitest-task";

export default defineConfig({
  run: {
    tasks: {
      test: vitestTask(["vitest run", "vitest run -c vitest.worker.config.ts"]),
    },
  },
});