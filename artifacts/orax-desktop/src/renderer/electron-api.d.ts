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
        listCloudProjects(): Promise<{ projects: unknown[] }>;
        createCloudProject(name: string): Promise<{ project: unknown }>;
        attachLocalFolderToProject(projectId: string): Promise<{ source: unknown } | null>;
        runProjectThread(params: {
          projectId: string;
          threadId: string;
          executionSourceId: string;
          localPath: string;
        }): Promise<{ ok: boolean; projectId: string; executionSourceId: string }>;
      };
      app: {
        getVersion(): Promise<string>;
      };
      relay: {
        getStatus(): Promise<RelayState>;
        restart(): Promise<RelayState>;
      };
      support: {
        exportDiagnostics(): Promise<SupportDiagnosticsExport | null>;
      };
      on: {
        hostStateChanged(cb: (state: HostState) => void): RemoveFn;
        pairingStateChanged(cb: (state: PairingState) => void): RemoveFn;
        relayStatusChanged(cb: (state: RelayState) => void): RemoveFn;
      };
    };
  }
}

export {};
