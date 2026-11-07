/**
 * app.ts: the Electron main process, written so it can be tested without Electron.
 *
 * `startApp` receives the `electron` module as an argument instead of importing it, so tests pass a fake. It wires
 * three things: the workbench services (Node side), the IPC handlers that expose them, and the browser window that
 * hosts the React UI. The window is locked down: no Node integration, context isolation on, sandboxed, no
 * navigation away from the app, no new windows.
 */
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import { createDispatcher, createWorkbench, dataFolders, SettingsService, type Workbench } from "@anneal/workbench";
import { IPC } from "../shared/bridge";
import { createSafeStorageSecrets } from "./secrets";

/** The parts of the `electron` module the app uses. Typed from the real module so a wrong call fails to compile. */
export type ElectronLike = Pick<typeof import("electron"), "app" | "BrowserWindow" | "ipcMain" | "dialog" | "shell" | "session" | "safeStorage">;

/** Everything the main process needs to know about where it runs. */
export interface AppConfig {
  /** Absolute path of the bundled preload script. */
  preloadPath: string;
  /** Absolute path of the built renderer's index.html (production). */
  rendererIndex: string;
  /** URL of the Vite dev server; when set, the window loads it instead of the built files. */
  devUrl?: string;
  /** Process environment: ANNEAL_LLM_* variables act as fallbacks for the settings. */
  env: Record<string, string | undefined>;
}

/**
 * Content-Security-Policy for the production window. The page runs only its own bundled script, makes no network
 * requests (everything goes through IPC), and may use inline styles (React sets style attributes).
 */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * True if `url` is a page of this app: a file inside the renderer's own folder in production (any other local file is
 * not trusted), or the dev server's origin in development.
 */
export function isAppUrl(url: string, cfg: Pick<AppConfig, "devUrl" | "rendererIndex">): boolean {
  if (cfg.devUrl) {
    try {
      return new URL(url).origin === new URL(cfg.devUrl).origin;
    } catch {
      return false;
    }
  }
  if (!url.startsWith("file://")) return false;
  try {
    const rel = relative(resolve(dirname(cfg.rendererIndex)), resolve(fileURLToPath(url)));
    return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Sites the app will open in the system browser: Wikipedia (the source pages of decks) and GitHub. */
const EXTERNAL_HOSTS = [/^([a-z-]+\.)?wikipedia\.org$/, /^github\.com$/];

/** True for a plain https URL on an allowed site (no embedded credentials): the only kind handed to the system browser. */
export function isSafeExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.username === "" && u.password === "" && EXTERNAL_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

/**
 * Starts the application: waits for Electron to be ready, builds the workbench, registers IPC handlers, opens the window.
 * @returns the workbench and a function that opens another window (used when the app is re-activated)
 */
export async function startApp(electron: ElectronLike, cfg: AppConfig): Promise<{ workbench: Workbench; createWindow: () => unknown }> {
  const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage } = electron;

  // Two app instances would edit the same drafts: keep one.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { workbench: undefined as never, createWindow: () => undefined };
  }
  await app.whenReady();

  const userData = app.getPath("userData");
  const folders = dataFolders(userData);
  const settings = new SettingsService(folders.settingsFile, createSafeStorageSecrets(safeStorage, join(userData, "secrets")), cfg.env);
  const workbench = createWorkbench({ settings, draftsDir: folders.draftsDir, llmCacheDir: folders.llmCacheDir });
  const dispatch = createDispatcher(workbench.api);

  /** IPC messages are accepted only from the app's own page, never from a frame that navigated elsewhere. */
  const assertTrusted = (e: IpcMainInvokeEvent) => {
    if (!isAppUrl(e.senderFrame?.url ?? "", cfg)) throw new Error("untrusted sender");
  };

  // async, so a rejected check is always a rejected promise and never a synchronous throw.
  ipcMain.handle(IPC.call, async (e, method: unknown, args: unknown) => {
    assertTrusted(e);
    return dispatch(method, args);
  });
  ipcMain.handle(IPC.pickFolder, async (e) => {
    assertTrusted(e);
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.openExternal, async (e, url: unknown) => {
    assertTrusted(e);
    if (!isSafeExternalUrl(url)) throw new Error("only https links to Wikipedia or GitHub can be opened");
    await shell.openExternal(url);
  });

  // Push job progress to every open window.
  workbench.subscribe((event) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.event, event);
  });

  // In production, forbid everything the app does not need. (Skipped in dev: Vite's hot reload needs more.)
  if (!cfg.devUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
    });
  }

  const createWindow = () => {
    const win = new BrowserWindow({
      width: 1280, height: 820, minWidth: 900, minHeight: 600, title: "Anneal Workbench",
      webPreferences: { preload: cfg.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url, cfg)) event.preventDefault();
    });
    void (cfg.devUrl ? win.loadURL(cfg.devUrl) : win.loadFile(cfg.rendererIndex));
    return win;
  };

  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  createWindow();
  return { workbench, createWindow };
}
