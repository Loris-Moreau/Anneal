/// <reference types="vite/client" />
/** Declares `window.anneal`, the bridge the preload script exposes (see src/main/preload.ts). */
import type { AnnealBridge } from "../shared/bridge";

declare global {
  interface Window {
    anneal: AnnealBridge;
  }
}
export {};
