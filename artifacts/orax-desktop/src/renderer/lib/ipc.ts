import type { PermissionMode, SupportDiagnosticsExportOptions } from "../../shared/types";

function api() {
  return window.electronAPI;
}

export const auth = {
  getSession: () => api().auth.getSession(),
  startSignIn: () => api().auth.startSignIn(),
  signOut: () => api().auth.signOut(),
};

export const host = {
  register: () => api().host.register(),
  getStatus: () => api().host.getStatus(),
  updatePermissionMode: (mode: PermissionMode) => api().host.updatePermissionMode(mode),
};

export const pairing = {
  create: () => api().pairing.create(),
  cancel: () => api().pairing.cancel(),
};

export const project = {
  addLocalFolder: () => api().project.addLocalFolder(),
  listLocalFolders: () => api().project.listLocalFolders(),
  removeLocalFolder: (id: string) => api().project.removeLocalFolder(id),
  listCloudProjects: () => api().project.listCloudProjects(),
  createCloudProject: (name: string) => api().project.createCloudProject(name),
  attachLocalFolderToProject: (projectId: string) =>
    api().project.attachLocalFolderToProject(projectId),
  runProjectThread: (params: {
    projectId: string;
    threadId: string;
    executionSourceId: string;
    localPath: string;
  }) => api().project.runProjectThread(params),
};

export const appInfo = {
  getVersion: () => api().app.getVersion(),
};

export const relay = {
  getStatus: () => api().relay.getStatus(),
  restart: () => api().relay.restart(),
};

export const support = {
  exportDiagnostics: (options?: SupportDiagnosticsExportOptions) =>
    api().support.exportDiagnostics(options),
};

export const events = {
  onHostStateChanged: (cb: (state: import("../../shared/types").HostState) => void) =>
    api().on.hostStateChanged(cb),
  onPairingStateChanged: (cb: (state: import("../../shared/types").PairingState) => void) =>
    api().on.pairingStateChanged(cb),
};
