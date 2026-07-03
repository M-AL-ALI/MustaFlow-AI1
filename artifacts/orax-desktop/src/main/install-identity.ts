import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export interface InstallIdentity {
  installId: string;
  deviceName: string;
  platform: "windows" | "mac" | "linux";
  osVersion: string;
  appVersion: string;
}

interface StoredIdentity {
  installId: string;
  deviceName: string;
}

function identityPath(): string {
  return join(app.getPath("userData"), "identity.json");
}

function detectPlatform(): "windows" | "mac" | "linux" {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "mac";
    default:
      return "linux";
  }
}

export function getOrCreateInstallIdentity(): InstallIdentity {
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });

  let stored: Partial<StoredIdentity> = {};
  const p = identityPath();
  if (existsSync(p)) {
    try {
      stored = JSON.parse(readFileSync(p, "utf8")) as Partial<StoredIdentity>;
    } catch {}
  }

  const installId = stored.installId ?? randomUUID();
  const deviceName = stored.deviceName ?? os.hostname();

  const persisted: StoredIdentity = { installId, deviceName };
  writeFileSync(p, JSON.stringify(persisted, null, 2), "utf8");

  return {
    installId,
    deviceName,
    platform: detectPlatform(),
    osVersion: os.release(),
    appVersion: app.getVersion(),
  };
}

export function updateDeviceName(identity: InstallIdentity, name: string): void {
  identity.deviceName = name;
  const p = identityPath();
  try {
    const stored: StoredIdentity = JSON.parse(readFileSync(p, "utf8")) as StoredIdentity;
    stored.deviceName = name;
    writeFileSync(p, JSON.stringify(stored, null, 2), "utf8");
  } catch {}
}
