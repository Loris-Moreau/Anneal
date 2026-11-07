/**
 * Development mode: serves the renderer with Vite (hot reload) and opens Electron pointed at it.
 *
 * The main process is bundled once at start; restart this script after changing files under src/main.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electronPath = require("electron"); // in Node, the electron package exports the path of the binary

await build({
  entryPoints: { main: "src/main/main.ts", preload: "src/main/preload.ts" },
  outdir: "dist/main", outExtension: { ".js": ".cjs" }, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: true,
});

const server = await createServer({ configFile: "vite.config.ts" });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";

const child = spawn(electronPath, ["."], { stdio: "inherit", env: { ...process.env, ANNEAL_DEV_URL: url } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
