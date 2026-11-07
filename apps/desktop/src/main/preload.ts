/**
 * preload.ts: runs in the page's isolated context before the UI loads and exposes `window.anneal`.
 *
 * Only these four functions cross the boundary. The page gets no `require`, no `ipcRenderer`, and cannot pick a
 * channel name: the channels are fixed here.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { JobEvent } from "@anneal/workbench/shared";
import { IPC, type AnnealBridge } from "../shared/bridge";

/** The object exposed to the page as window.anneal. */
const bridge: AnnealBridge = {
  call: (method, ...args) => ipcRenderer.invoke(IPC.call, method, args),
  onEvent(listener) {
    const handler = (_event: unknown, payload: JobEvent) => listener(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => void ipcRenderer.removeListener(IPC.event, handler);
  },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld("anneal", bridge);
