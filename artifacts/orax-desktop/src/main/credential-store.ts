import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function storePath(key: string): string {
  return join(app.getPath("userData"), `cred-${key}.bin`);
}

export function storeEncrypted(key: string, value: string): void {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value);
    writeFileSync(storePath(key), encrypted);
  } else {
    writeFileSync(storePath(key) + ".plaintext", value, "utf8");
    console.warn("[CredentialStore] safeStorage unavailable; falling back to plaintext (dev only)");
  }
}

export function loadEncrypted(key: string): string | null {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const p = storePath(key);
      if (!existsSync(p)) return null;
      const buf = readFileSync(p);
      return safeStorage.decryptString(buf);
    } else {
      const p = storePath(key) + ".plaintext";
      if (!existsSync(p)) return null;
      const val = readFileSync(p, "utf8");
      return val || null;
    }
  } catch {
    return null;
  }
}

export function deleteEncrypted(key: string): void {
  try {
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    const p = storePath(key);
    if (existsSync(p)) unlinkSync(p);
    const pp = p + ".plaintext";
    if (existsSync(pp)) unlinkSync(pp);
  } catch {}
}
