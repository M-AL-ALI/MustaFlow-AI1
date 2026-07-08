import { contextBridge, ipcRenderer } from "electron";
import type {
  AuthSession,
  HostState,
  PairingState,
  LocalProject,
  PermissionMode,
  RelayState,
  SupportDiagnosticsExport,
} from "../shared/types";

type RemoveFn = () => void;

const electronAPI = {
  auth: {
    getSession: (): Promise<Omit<AuthSession, "token"> | null> =>
      ipcRenderer.invoke("auth:getSession"),
    startSignIn: (): Promise<void> => ipcRenderer.invoke("auth:startSignIn"),
    signOut: (): Promise<void> => ipcRenderer.invoke("auth:signOut"),
  },
  host: {
    register: (): Promise<HostState> => ipcRenderer.invoke("host:register"),
    getStatus: (): Promise<HostState> => ipcRenderer.invoke("host:getStatus"),
    updatePermissionMode: (mode: PermissionMode): Promise<void> =>
      ipcRenderer.invoke("host:updatePermissionMode", mode),
  },
  pairing: {
    create: (): Promise<PairingState> => ipcRenderer.invoke("pairing:create"),
    cancel: (): Promise<void> => ipcRenderer.invoke("pairing:cancel"),
  },
  project: {
    addLocalFolder: (): Promise<LocalProject | null> =>
      ipcRenderer.invoke("project:addLocalFolder"),
    listLocalFolders: (): Promise<LocalProject[]> => ipcRenderer.invoke("project:listLocalFolders"),
    removeLocalFolder: (id: string): Promise<void> =>
      ipcRenderer.invoke("project:removeLocalFolder", id),
    listCloudProjects: (): Promise<{ projects: unknown[] }> =>
      ipcRenderer.invoke("project:listCloudProjects"),
    createCloudProject: (name: string): Promise<{ project: unknown }> =>
      ipcRenderer.invoke("project:createCloudProject", name),
    attachLocalFolderToProject: (projectId: string): Promise<{ source: unknown } | null> =>
      ipcRenderer.invoke("project:attachLocalFolderToProject", projectId),
    runProjectThread: (params: {
      projectId: string;
      threadId: string;
      executionSourceId: string;
      localPath: string;
    }): Promise<{ ok: boolean; projectId: string; executionSourceId: string }> =>
      ipcRenderer.invoke("project:runProjectThread", params),
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
  },
  relay: {
    getStatus: (): Promise<RelayState> => ipcRenderer.invoke("relay:getStatus"),
    restart: (): Promise<RelayState> => ipcRenderer.invoke("relay:restart"),
  },
  support: {
    exportDiagnostics: (): Promise<SupportDiagnosticsExport | null> =>
      ipcRenderer.invoke("support:exportDiagnostics"),
  },
  on: {
    hostStateChanged: (cb: (state: HostState) => void): RemoveFn => {
      const handler = (_: Electron.IpcRendererEvent, state: HostState) => cb(state);
      ipcRenderer.on("host:stateChanged", handler);
      return () => ipcRenderer.removeListener("host:stateChanged", handler);
    },
    pairingStateChanged: (cb: (state: PairingState) => void): RemoveFn => {
      const handler = (_: Electron.IpcRendererEvent, state: PairingState) => cb(state);
      ipcRenderer.on("pairing:stateChanged", handler);
      return () => ipcRenderer.removeListener("pairing:stateChanged", handler);
    },
    relayStatusChanged: (cb: (state: RelayState) => void): RemoveFn => {
      const handler = (_: Electron.IpcRendererEvent, state: RelayState) => cb(state);
      ipcRenderer.on("relay:statusChanged", handler);
      return () => ipcRenderer.removeListener("relay:statusChanged", handler);
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;
