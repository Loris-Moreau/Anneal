/**
 * Bundles the Electron main process and the preload script into dist/main/*.cjs.
 *
 * Everything except `electron` is bundled in, including the workspace packages (@anneal/*), so the packaged app
 * needs no node_modules. Both outputs are CommonJS: Electron's sandboxed preload requires it, and the main
 * process uses the same format for simplicity.
 */
import { build } from "esbuild";

await build({
  entryPoints: { main: "src/main/main.ts", preload: "src/main/preload.ts" },
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
