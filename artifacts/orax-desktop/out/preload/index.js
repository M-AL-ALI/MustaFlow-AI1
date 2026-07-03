"use strict";
const electron = require("electron");
const electronAPI = {
  auth: {
    getSession: () => electron.ipcRenderer.invoke("auth:getSession"),
    startSignIn: () => electron.ipcRenderer.invoke("auth:startSignIn"),
    signOut: () => electron.ipcRenderer.invoke("auth:signOut")
  },
  host: {
    register: () => electron.ipcRenderer.invoke("host:register"),
    getStatus: () => electron.ipcRenderer.invoke("host:getStatus"),
    updatePermissionMode: (mode) => electron.ipcRenderer.invoke("host:updatePermissionMode", mode)
  },
  pairing: {
    create: () => electron.ipcRenderer.invoke("pairing:create"),
    cancel: () => electron.ipcRenderer.invoke("pairing:cancel")
  },
  project: {
    addLocalFolder: () => electron.ipcRenderer.invoke("project:addLocalFolder"),
    listLocalFolders: () => electron.ipcRenderer.invoke("project:listLocalFolders"),
    removeLocalFolder: (id) => electron.ipcRenderer.invoke("project:removeLocalFolder", id)
  },
  app: {
    getVersion: () => electron.ipcRenderer.invoke("app:getVersion")
  },
  on: {
    hostStateChanged: (cb) => {
      const handler = (_, state) => cb(state);
      electron.ipcRenderer.on("host:stateChanged", handler);
      return () => electron.ipcRenderer.removeListener("host:stateChanged", handler);
    },
    pairingStateChanged: (cb) => {
      const handler = (_, state) => cb(state);
      electron.ipcRenderer.on("pairing:stateChanged", handler);
      return () => electron.ipcRenderer.removeListener("pairing:stateChanged", handler);
    }
  }
};
electron.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
