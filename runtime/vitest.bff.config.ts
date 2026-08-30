import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "../src"),
      "server-only": resolve(import.meta.dirname, "integration/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts"],
    fileParallelism: false,
  },
});
