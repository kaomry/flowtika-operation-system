import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The database test files share one throwaway database, so they must not run at once.
    fileParallelism: false,
  },
});
