import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSafeStorageSecrets, type SafeStorageLike } from "../../src/main/secrets";

/** A stand-in for safeStorage: reversible, but the ciphertext does not contain the plaintext. */
const fakeSafeStorage = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from("enc:" + [...s].reverse().join("")),
  decryptString: (b) => {
    const t = b.toString();
    if (!t.startsWith("enc:")) throw new Error("cannot decrypt");
    return [...t.slice(4)].reverse().join("");
  },
});

describe("createSafeStorageSecrets", () => {
  it("stores a secret encrypted on disk and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sec-"));
    const s = createSafeStorageSecrets(fakeSafeStorage(), dir);
    expect(await s.get("llm-api-key")).toBeNull();
    await s.set("llm-api-key", "AQ.secret-value");
    expect(await s.get("llm-api-key")).toBe("AQ.secret-value");
    expect(await readFile(join(dir, "llm-api-key.bin"), "utf8")).not.toContain("secret-value");
  });

  it("deletes a secret with null, and deleting a missing one is fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sec-"));
    const s = createSafeStorageSecrets(fakeSafeStorage(), dir);
    await s.set("k", "v");
    await s.set("k", null);
    await s.set("k", null);
    expect(await s.get("k")).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it("treats an undecryptable file as no key instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sec-"));
    const writer = createSafeStorageSecrets(fakeSafeStorage(), dir);
    await writer.set("k", "v");
    const other = createSafeStorageSecrets({ ...fakeSafeStorage(), decryptString: () => { throw new Error("different account"); } }, dir);
    expect(await other.get("k")).toBeNull();
  });

  it("refuses to store when the system cannot encrypt, and reports unavailability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sec-"));
    const s = createSafeStorageSecrets(fakeSafeStorage(false), dir);
    expect(s.available()).toBe(false);
    await expect(s.set("k", "v")).rejects.toThrow(/cannot encrypt/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("only accepts simple secret names, so a name can never become a path", async () => {
    const s = createSafeStorageSecrets(fakeSafeStorage(), await mkdtemp(join(tmpdir(), "sec-")));
    await expect(s.set("../evil", "v")).rejects.toThrow(/invalid secret name/);
    expect(await s.get("a/b")).toBeNull(); // get never throws
  });
});
