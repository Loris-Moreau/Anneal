/**
 * secrets.ts: a SecretStore backed by Electron's safeStorage.
 *
 * safeStorage encrypts with the operating system's credential facility (DPAPI on Windows, Keychain on macOS), so
 * the API key is unreadable to other users and to anything that merely copies the app's data folder. The encrypted
 * bytes are stored one file per secret; the plaintext never touches disk.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretStore } from "@anneal/workbench";

/** The part of Electron's safeStorage that is used here (lets tests pass a fake). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Secret names become file names, so only a conservative set of characters is allowed. */
const SAFE_NAME = /^[a-z0-9-]+$/;

/**
 * Creates a store that keeps each secret as `<dir>/<name>.bin`, encrypted.
 * `get` returns null for a missing or undecryptable secret (for example after the OS account changed), so a stale
 * file degrades to "no key set" instead of crashing the app.
 */
export function createSafeStorageSecrets(safeStorage: SafeStorageLike, dir: string): SecretStore {
  const file = (name: string) => {
    if (!SAFE_NAME.test(name)) throw new Error(`invalid secret name: ${name}`);
    return join(dir, `${name}.bin`);
  };
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    async get(name) {
      try {
        return safeStorage.decryptString(await readFile(file(name)));
      } catch {
        return null;
      }
    },
    async set(name, value) {
      if (value === null) {
        await rm(file(name), { force: true });
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error("this system cannot encrypt secrets");
      await mkdir(dir, { recursive: true });
      await writeFile(file(name), safeStorage.encryptString(value));
    },
  };
}
