import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/db", "packages/shared", "packages/adapters/opencode-local", "server", "ui", "cli"],
  },
});
