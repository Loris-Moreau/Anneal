/**
 * main.ts: Electron entry point. Kept to a few lines on purpose: all logic lives in app.ts, where it can be tested.
 */
import { join } from "node:path";
import * as electron from "electron";
import { startApp } from "./app";

startApp(electron, {
  // After bundling, this file and preload.cjs sit side by side in dist/main; the renderer is in dist/renderer.
  preloadPath: join(__dirname, "preload.cjs"),
  rendererIndex: join(__dirname, "..", "renderer", "index.html"),
  ...(process.env["ANNEAL_DEV_URL"] ? { devUrl: process.env["ANNEAL_DEV_URL"] } : {}),
  env: process.env,
}).catch((error: unknown) => {
  electron.dialog.showErrorBox("Anneal Workbench could not start", error instanceof Error ? error.message : String(error));
  electron.app.quit();
});
