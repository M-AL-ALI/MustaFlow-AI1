import type { AuthSession, HostState, PairingState, LocalProject, PermissionMode } from "../shared/types";

type RemoveFn = () => void;

declare global {
  interface Window {
    electronAPI: {
      auth: {
        getSession(): Promise<Omit<AuthSession, "token"> | null>;
        startSignIn(): Promise<void>;
        signOut(): Promise<void>;
      };
      host: {
        register(): Promise<HostState>;
        getStatus(): Promise<HostState>;
        updatePermissionMode(mode: PermissionMode): Promise<void>;
      };
      pairing: {
        create(): Promise<PairingState>;
        cancel(): Promise<void>;
      };
      project: {
        addLocalFolder(): Promise<LocalProject | null>;
        listLocalFolders(): Promise<LocalProject[]>;
        removeLocalFolder(id: string): Promise<void>;
      };
      app: {
        getVersion(): Promise<string>;
      };
      on: {
        hostStateChanged(cb: (state: HostState) => void): RemoveFn;
        pairingStateChanged(cb: (state: PairingState) => void): RemoveFn;
      };
    };
  }
}

export {};
