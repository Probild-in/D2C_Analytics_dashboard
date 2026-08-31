import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 20000,
    // Every test file that touches the database calls resetTestDb(), which
    // drops and recreates the shared `public` schema against ONE real
    // Postgres database (no per-worker isolation). Running test files in
    // parallel races these resets against each other. The project is small
    // enough that serial file execution costs nothing meaningful.
    fileParallelism: false,
  },
});
