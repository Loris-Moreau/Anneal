import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSP, isAppUrl, isSafeExternalUrl, startApp, type AppConfig, type ElectronLike } from "../../src/main/app";
import { IPC } from "../../src/shared/bridge";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** A fake `electron` module that records what the app registers. */
async function fakeElectron(options: { lock?: boolean } = {}) {
  const userData = await mkdtemp(join(tmpdir(), "app-"));
  const handlers = new Map<string, Handler>();
  const appEvents = new Map<string, () => void>();
  const windows: FakeWindow[] = [];
  class FakeWindow {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn() };
    loadFile = vi.fn();
    loadURL = vi.fn();
    isMinimized = vi.fn(() => true);
    restore = vi.fn();
    focus = vi.fn();
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      windows.push(this);
    }
    static getAllWindows() {
      return windows;
    }
  }
  const app = {
    requestSingleInstanceLock: vi.fn(() => options.lock ?? true),
    quit: vi.fn(),
    whenReady: vi.fn(async () => {}),
    getPath: vi.fn(() => userData),
    on: vi.fn((event: string, cb: () => void) => void appEvents.set(event, cb)),
  };
  const webRequest = { onHeadersReceived: vi.fn() };
  const electron = {
    app, BrowserWindow: FakeWindow,
    ipcMain: { handle: vi.fn((channel: string, fn: Handler) => void handlers.set(channel, fn)) },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/chosen/folder"] })) },
    shell: { openExternal: vi.fn(async () => {}) },
    session: { defaultSession: { webRequest } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  };
  return { electron: electron as unknown as ElectronLike, raw: electron, handlers, appEvents, windows, webRequest, userData };
}

const cfg = (extra: Partial<AppConfig> = {}): AppConfig => ({ preloadPath: "/app/dist/main/preload.cjs", rendererIndex: "/app/dist/renderer/index.html", env: {}, ...extra });
const FROM_APP = { senderFrame: { url: "file:///app/dist/renderer/index.html" } };
const FROM_ELSEWHERE = { senderFrame: { url: "https://evil.example/" } };
const FROM_OTHER_FILE = { senderFrame: { url: "file:///tmp/evil.html" } };

afterEach(() => vi.unstubAllGlobals());

describe("isAppUrl", () => {
  const prod = { rendererIndex: "/app/dist/renderer/index.html" };
  const dev = { devUrl: "http://localhost:5173/", rendererIndex: prod.rendererIndex };
  it("in production trusts only files inside the renderer folder", () => {
    expect(isAppUrl("file:///app/dist/renderer/index.html", prod)).toBe(true);
    expect(isAppUrl("file:///app/dist/renderer/assets/index-abc.js", prod)).toBe(true);
    expect(isAppUrl("file:///app/dist/main/main.cjs", prod)).toBe(false);
    expect(isAppUrl("file:///etc/passwd", prod)).toBe(false);
    expect(isAppUrl("file:///app/dist/renderer/../main/main.cjs", prod)).toBe(false);
    expect(isAppUrl("file:///app/dist/renderer-evil/index.html", prod)).toBe(false);
    expect(isAppUrl("https://example.org/", prod)).toBe(false);
    expect(isAppUrl("file://", prod)).toBe(false);
  });
  it("in development trusts only the dev server's origin", () => {
    expect(isAppUrl("http://localhost:5173/x", dev)).toBe(true);
    expect(isAppUrl("http://localhost:6000/", dev)).toBe(false);
    expect(isAppUrl("file:///app/dist/renderer/index.html", dev)).toBe(false);
    expect(isAppUrl("not a url", dev)).toBe(false);
  });
});

describe("isSafeExternalUrl", () => {
  it("allows plain https links to Wikipedia and GitHub only", () => {
    for (const good of ["https://en.wikipedia.org/wiki/Energy", "https://wikipedia.org/", "https://github.com/me/Anneal"]) expect(isSafeExternalUrl(good)).toBe(true);
    for (const bad of ["http://en.wikipedia.org/wiki/X", "https://example.org", "https://wikipedia.org.evil.example/", "https://notwikipedia.org/", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@en.wikipedia.org/", "https://", "", "x", 5, null]) expect(isSafeExternalUrl(bad)).toBe(false);
  });
});

describe("CSP", () => {
  it("allows only the app's own script and no network from the page", () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).not.toContain("unsafe-eval");
  });
});

describe("startApp", () => {
  it("opens one locked-down window that loads the built UI", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    expect(f.raw.app.whenReady).toHaveBeenCalled();
    expect(f.windows).toHaveLength(1);
    expect(f.windows[0]!.options.webPreferences).toEqual({ preload: "/app/dist/main/preload.cjs", contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(f.windows[0]!.loadFile).toHaveBeenCalledWith("/app/dist/renderer/index.html");
    expect(f.windows[0]!.loadURL).not.toHaveBeenCalled();
  });

  it("loads the dev server in development and skips the CSP header", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg({ devUrl: "http://localhost:5173/" }));
    expect(f.windows[0]!.loadURL).toHaveBeenCalledWith("http://localhost:5173/");
    expect(f.webRequest.onHeadersReceived).not.toHaveBeenCalled();
  });

  it("adds the CSP header to every response in production", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    const hook = f.webRequest.onHeadersReceived.mock.calls[0]![0] as (d: unknown, cb: (r: unknown) => void) => void;
    const cb = vi.fn();
    hook({ responseHeaders: { "X-Other": ["1"] } }, cb);
    expect(cb).toHaveBeenCalledWith({ responseHeaders: { "X-Other": ["1"], "Content-Security-Policy": [CSP] } });
  });

  it("denies new windows and blocks navigation away from the app", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    const wc = f.windows[0]!.webContents;
    expect((wc.setWindowOpenHandler.mock.calls[0]![0] as () => unknown)()).toEqual({ action: "deny" });
    const nav = wc.on.mock.calls.find((c) => c[0] === "will-navigate")![1] as (e: { preventDefault(): void }, url: string) => void;
    const away = { preventDefault: vi.fn() };
    nav(away, "https://example.org/");
    expect(away.preventDefault).toHaveBeenCalled();
    const stay = { preventDefault: vi.fn() };
    nav(stay, "file:///app/dist/renderer/index.html");
    expect(stay.preventDefault).not.toHaveBeenCalled();
    const otherFile = { preventDefault: vi.fn() };
    nav(otherFile, "file:///etc/passwd");
    expect(otherFile.preventDefault).toHaveBeenCalled();
  });

  it("dispatches workbench calls from the app page, and rejects other senders and unknown methods", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    const call = f.handlers.get(IPC.call)!;
    expect(await call(FROM_APP, "getSettings", [])).toMatchObject({ maxConcepts: 6, hasApiKey: false });
    await expect(call(FROM_ELSEWHERE, "getSettings", [])).rejects.toThrow(/untrusted sender/);
    await expect(call({ senderFrame: null }, "getSettings", [])).rejects.toThrow(/untrusted sender/);
    await expect(call(FROM_OTHER_FILE, "getSettings", [])).rejects.toThrow(/untrusted sender/);
    await expect(call(FROM_APP, "constructor", [])).rejects.toThrow(/unknown method/);
  });

  it("forwards job events to every window", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    await f.handlers.get(IPC.call)!(FROM_APP, "startGeneration", [{ title: "Anything", llm: false }]);
    const send = f.windows[0]!.webContents.send;
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.event, expect.objectContaining({ type: "error", message: expect.stringContaining("offline") })));
  });

  it("opens the native folder chooser for the app page only, and returns null when cancelled", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    const pick = f.handlers.get(IPC.pickFolder)!;
    expect(await pick(FROM_APP)).toBe("/chosen/folder");
    f.raw.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await pick(FROM_APP)).toBeNull();
    await expect(pick(FROM_ELSEWHERE)).rejects.toThrow(/untrusted/);
  });

  it("opens only https links to known sites in the system browser", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    const open = f.handlers.get(IPC.openExternal)!;
    await open(FROM_APP, "https://en.wikipedia.org/wiki/Energy");
    expect(f.raw.shell.openExternal).toHaveBeenCalledWith("https://en.wikipedia.org/wiki/Energy");
    for (const bad of ["http://en.wikipedia.org/x", "https://example.org", "file:///c:/x", "javascript:alert(1)", 42]) await expect(open(FROM_APP, bad)).rejects.toThrow(/only https/);
    await expect(open(FROM_ELSEWHERE, "https://en.wikipedia.org/")).rejects.toThrow(/untrusted/);
    expect(f.raw.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("quits at once if another instance is already running", async () => {
    const f = await fakeElectron({ lock: false });
    await startApp(f.electron, cfg());
    expect(f.raw.app.quit).toHaveBeenCalled();
    expect(f.raw.app.whenReady).not.toHaveBeenCalled();
    expect(f.windows).toHaveLength(0);
  });

  it("focuses the existing window on a second launch and reopens one when re-activated with none", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    f.appEvents.get("second-instance")!();
    expect(f.windows[0]!.restore).toHaveBeenCalled();
    expect(f.windows[0]!.focus).toHaveBeenCalled();
    f.windows.length = 0;
    f.appEvents.get("activate")!();
    expect(f.windows).toHaveLength(1);
  });

  it("quits when the last window closes (except on macOS)", async () => {
    const f = await fakeElectron();
    await startApp(f.electron, cfg());
    f.appEvents.get("window-all-closed")!();
    expect(f.raw.app.quit).toHaveBeenCalledTimes(process.platform === "darwin" ? 0 : 1);
  });
});
