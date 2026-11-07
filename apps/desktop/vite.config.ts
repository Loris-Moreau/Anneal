/**
 * Vite builds the renderer (the React UI) and runs the UI tests.
 *
 * `base: "./"` makes asset URLs relative, which the packaged app needs because it loads index.html from disk (file://).
 * The main process and preload are bundled separately by scripts/build-main.mjs.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config"; // vite's own defineConfig does not know the `test` section

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
  server: { port: 5173, strictPort: true },
  test: {
    // Tests live outside the Vite root; jsdom is selected per file with a docblock where a DOM is needed.
    root: ".",
    include: ["test/**/*.test.{ts,tsx}"],
    globals: true, // lets Testing Library clean up after each test automatically
  },
});
