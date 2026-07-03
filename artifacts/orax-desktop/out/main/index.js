"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const node_path = require("node:path");
const node_crypto = require("node:crypto");
const node_fs = require("node:fs");
const os = require("node:os");
const IS_DEV_AUTH = process.env.NODE_ENV === "development" || process.env.ORAX_DEV_AUTH === "true";
class DevAuthAdapter {
  _session = null;
  async getSession() {
    if (this._session) return this._session;
    const token = process.env.ORAX_DEV_TOKEN;
    if (!token) return null;
    this._session = {
      userId: process.env.ORAX_DEV_USER_ID ?? "dev-user-000",
      email: process.env.ORAX_DEV_EMAIL ?? "dev@orax.local",
      displayName: process.env.ORAX_DEV_DISPLAY_NAME ?? "Dev User",
      token
    };
    return this._session;
  }
  async startSignIn() {
    console.log("[DevAuth] startSignIn — set ORAX_DEV_TOKEN env var to authenticate");
  }
  async signOut() {
    this._session = null;
  }
}
class ProductionAuthAdapter {
  async getSession() {
    return null;
  }
  async startSignIn() {
    const { shell } = await import("electron");
    const deviceFlowUrl = (process.env.ORAX_API_BASE_URL ?? "https://www.mustaflow.com") + "/orax/device-login";
    await shell.openExternal(deviceFlowUrl);
  }
  async signOut() {
    const { storeEncrypted } = await Promise.resolve().then(() => require("./chunks/credential-store-7P-eHEH5.js"));
    storeEncrypted("orax-session-token", "");
  }
}
function createAuthAdapter() {
  if (IS_DEV_AUTH) {
    console.log("[Auth] Dev auth mode enabled (ORAX_DEV_AUTH=true or NODE_ENV=development)");
    return new DevAuthAdapter();
  }
  return new ProductionAuthAdapter();
}
function identityPath() {
  return node_path.join(electron.app.getPath("userData"), "identity.json");
}
function detectPlatform() {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "mac";
    default:
      return "linux";
  }
}
function getOrCreateInstallIdentity() {
  const dir = electron.app.getPath("userData");
  node_fs.mkdirSync(dir, { recursive: true });
  let stored = {};
  const p = identityPath();
  if (node_fs.existsSync(p)) {
    try {
      stored = JSON.parse(node_fs.readFileSync(p, "utf8"));
    } catch {
    }
  }
  const installId = stored.installId ?? node_crypto.randomUUID();
  const deviceName = stored.deviceName ?? os.hostname();
  const persisted = { installId, deviceName };
  node_fs.writeFileSync(p, JSON.stringify(persisted, null, 2), "utf8");
  return {
    installId,
    deviceName,
    platform: detectPlatform(),
    osVersion: os.release(),
    appVersion: electron.app.getVersion()
  };
}
const DEFAULT_BASE = "https://www.mustaflow.com";
class OraxApiClient {
  constructor(getToken) {
    this.getToken = getToken;
    this.baseUrl = process.env.ORAX_API_BASE_URL ?? DEFAULT_BASE;
  }
  baseUrl;
  async request(method, path, body) {
    const token = await this.getToken();
    const headers = {
      "Content-Type": "application/json",
      "X-Client": "orax-desktop"
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== void 0 ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      throw new Error(`[OraxAPI] ${method} ${path} → ${res.status}`);
    }
    return res.json();
  }
  async registerHost(payload) {
    return this.request("POST", "/api/orax/hosts/register", payload);
  }
  async updateHost(hostId, patch) {
    await this.request("PATCH", `/api/orax/hosts/${hostId}`, patch);
  }
  async heartbeat(hostId, appVersion) {
    await this.request("POST", "/api/orax/relay/heartbeat", { hostId, appVersion });
  }
  async createPairingCode(hostId) {
    return this.request("POST", "/api/orax/pairing-codes", { hostId });
  }
  async cancelPairingCode(code) {
    await this.request("DELETE", `/api/orax/pairing-codes/${encodeURIComponent(code)}`);
  }
}
const HEARTBEAT_INTERVAL_MS = 3e4;
class HostManager {
  constructor(api, identity) {
    this.api = api;
    this.identity = identity;
    this.state = {
      hostId: null,
      status: "unregistered",
      permissionMode: "ask_risky",
      deviceName: identity.deviceName,
      platform: identity.platform,
      appVersion: identity.appVersion
    };
  }
  state;
  heartbeatTimer = null;
  onChange = null;
  setOnChange(cb) {
    this.onChange = cb;
  }
  getState() {
    return { ...this.state };
  }
  async register() {
    const payload = {
      deviceName: this.identity.deviceName,
      platform: this.identity.platform,
      osVersion: this.identity.osVersion,
      appVersion: this.identity.appVersion,
      installId: this.identity.installId,
      publicKey: "",
      capabilities: {
        shell: false,
        filesystem: false,
        git: false,
        github: false,
        browser: false,
        screenshot: false,
        computer_use: false
      },
      metadata: { appVersion: this.identity.appVersion }
    };
    const result = await this.api.registerHost(payload);
    this.state.hostId = result.host.id;
    this.state.permissionMode = result.host.permissionMode;
    this.state.status = "online";
    this.emit();
    this.startHeartbeat();
    return this.getState();
  }
  async updatePermissionMode(mode) {
    if (!this.state.hostId) throw new Error("Host not registered");
    await this.api.updateHost(this.state.hostId, { permissionMode: mode });
    this.state.permissionMode = mode;
    this.emit();
  }
  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }
  async sendHeartbeat() {
    if (!this.state.hostId) return;
    try {
      await this.api.heartbeat(this.state.hostId, this.identity.appVersion);
      if (this.state.status !== "online") {
        this.state.status = "online";
        this.emit();
      }
    } catch {
      this.state.status = this.state.status === "reconnecting" ? "offline" : "reconnecting";
      this.emit();
    }
  }
  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  emit() {
    this.onChange?.({ ...this.state });
  }
}
class PairingManager {
  constructor(api) {
    this.api = api;
  }
  state = {
    code: null,
    qrPayload: null,
    expiresAt: null,
    isActive: false
  };
  onChange = null;
  setOnChange(cb) {
    this.onChange = cb;
  }
  getState() {
    return { ...this.state };
  }
  async createCode(hostId) {
    const result = await this.api.createPairingCode(hostId);
    this.state = {
      code: result.code,
      qrPayload: result.qrPayload,
      expiresAt: result.expiresAt,
      isActive: true
    };
    this.emit();
    return this.getState();
  }
  async cancelCode() {
    if (!this.state.code) return;
    const code = this.state.code;
    this.clearState();
    try {
      await this.api.cancelPairingCode(code);
    } catch (err) {
      console.error("[PairingManager] cancel error:", err);
    }
  }
  clearState() {
    this.state = { code: null, qrPayload: null, expiresAt: null, isActive: false };
    this.emit();
  }
  emit() {
    this.onChange?.({ ...this.state });
  }
}
function projectsPath() {
  return node_path.join(electron.app.getPath("userData"), "local-projects.json");
}
function load() {
  try {
    const raw = node_fs.readFileSync(projectsPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function save(projects) {
  node_fs.mkdirSync(electron.app.getPath("userData"), { recursive: true });
  node_fs.writeFileSync(projectsPath(), JSON.stringify(projects, null, 2), "utf8");
}
class LocalProjectsManager {
  list() {
    return load();
  }
  add(localPath) {
    const projects = load();
    const existing = projects.find((p) => p.localPath === localPath);
    if (existing) return existing;
    const project = {
      id: node_crypto.randomUUID(),
      displayName: node_path.basename(localPath) || localPath,
      localPath,
      addedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    projects.push(project);
    save(projects);
    return project;
  }
  remove(id) {
    const projects = load().filter((p) => p.id !== id);
    save(projects);
  }
}
function registerIpcHandlers(deps) {
  const { auth, hostManager, pairingManager, localProjects, win } = deps;
  electron.ipcMain.handle("auth:getSession", async () => {
    const session = await auth.getSession();
    if (!session) return null;
    return { userId: session.userId, email: session.email, displayName: session.displayName };
  });
  electron.ipcMain.handle("auth:startSignIn", async () => {
    await auth.startSignIn();
  });
  electron.ipcMain.handle("auth:signOut", async () => {
    await auth.signOut();
    hostManager.stop();
    pairingManager.clearState();
  });
  electron.ipcMain.handle("host:register", async () => {
    return hostManager.register();
  });
  electron.ipcMain.handle("host:getStatus", () => {
    return hostManager.getState();
  });
  electron.ipcMain.handle("host:updatePermissionMode", async (_event, mode) => {
    await hostManager.updatePermissionMode(mode);
  });
  electron.ipcMain.handle("pairing:create", async () => {
    const { hostId } = hostManager.getState();
    if (!hostId) throw new Error("Host not registered");
    return pairingManager.createCode(hostId);
  });
  electron.ipcMain.handle("pairing:cancel", async () => {
    await pairingManager.cancelCode();
  });
  electron.ipcMain.handle("project:listLocalFolders", () => {
    return localProjects.list();
  });
  electron.ipcMain.handle("project:addLocalFolder", async () => {
    const result = await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Add Local Project Folder"
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return localProjects.add(result.filePaths[0]);
  });
  electron.ipcMain.handle("project:removeLocalFolder", (_event, id) => {
    localProjects.remove(id);
  });
  electron.ipcMain.handle("app:getVersion", () => {
    const { app } = require("electron");
    return app.getVersion();
  });
  electron.ipcMain.handle("logs:getRecent", () => {
    return [];
  });
  hostManager.setOnChange((state) => {
    if (!win.isDestroyed()) win.webContents.send("host:stateChanged", state);
  });
  pairingManager.setOnChange((state) => {
    if (!win.isDestroyed()) win.webContents.send("pairing:stateChanged", state);
  });
}
electron.app.setName("Orax Desktop");
let mainWindow = null;
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(node_path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
electron.app.whenReady().then(() => {
  const identity = getOrCreateInstallIdentity();
  const auth = createAuthAdapter();
  const apiClient = new OraxApiClient(() => auth.getSession().then((s) => s?.token ?? null));
  const hostManager = new HostManager(apiClient, identity);
  const pairingManager = new PairingManager(apiClient);
  const localProjects = new LocalProjectsManager();
  mainWindow = createWindow();
  registerIpcHandlers({
    auth,
    hostManager,
    pairingManager,
    localProjects,
    win: mainWindow
  });
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
}).catch((err) => {
  console.error("[Main] startup error:", err);
  electron.app.quit();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
