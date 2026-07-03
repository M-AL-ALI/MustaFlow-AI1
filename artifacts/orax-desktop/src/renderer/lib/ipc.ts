import type { PermissionMode } from "../../shared/types";

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
};

export const appInfo = {
  getVersion: () => api().app.getVersion(),
};

export const events = {
  onHostStateChanged: (cb: (state: import("../../shared/types").HostState) => void) =>
    api().on.hostStateChanged(cb),
  onPairingStateChanged: (cb: (state: import("../../shared/types").PairingState) => void) =>
    api().on.pairingStateChanged(cb),
};
