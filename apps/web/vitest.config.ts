import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname)
    }
  },
  test: {
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100
      }
    }
  }
});
