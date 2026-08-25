import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Unit tests for pure helpers (no Electron, no DOM by default). Kept deliberately narrow:
// the test runner must NOT pull in main-process modules. Add files as more pure
// logic is extracted for testing.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.{js,ts,jsx,tsx}"],
    environment: "node",
  },
});
