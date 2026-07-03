"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const node_fs = require("node:fs");
const node_path = require("node:path");
function storePath(key) {
  return node_path.join(electron.app.getPath("userData"), `cred-${key}.bin`);
}
function storeEncrypted(key, value) {
  const dir = electron.app.getPath("userData");
  node_fs.mkdirSync(dir, { recursive: true });
  if (electron.safeStorage.isEncryptionAvailable()) {
    const encrypted = electron.safeStorage.encryptString(value);
    node_fs.writeFileSync(storePath(key), encrypted);
  } else {
    node_fs.writeFileSync(storePath(key) + ".plaintext", value, "utf8");
    console.warn("[CredentialStore] safeStorage unavailable; falling back to plaintext (dev only)");
  }
}
exports.storeEncrypted = storeEncrypted;
