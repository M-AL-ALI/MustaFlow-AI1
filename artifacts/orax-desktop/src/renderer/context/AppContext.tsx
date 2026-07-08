import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import type {
  AuthSession,
  HostState,
  PairingState,
  LocalProject,
  PermissionMode,
} from "../../shared/types";
import { auth, host, project, events } from "../lib/ipc";

interface AppContextValue {
  session: Omit<AuthSession, "token"> | null;
  hostState: HostState | null;
  pairingState: PairingState | null;
  localProjects: LocalProject[];
  isLoadingSession: boolean;
  currentPage: Page;
  setPage: (page: Page) => void;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  registerHost: () => Promise<void>;
  updatePermissionMode: (mode: PermissionMode) => Promise<void>;
  refreshProjects: () => Promise<void>;
}

export type Page = "home" | "health" | "pairing" | "projects" | "settings";

const AppCtx = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Omit<AuthSession, "token"> | null>(null);
  const [hostState, setHostState] = useState<HostState | null>(null);
  const [pairingState, setPairingState] = useState<PairingState | null>(null);
  const [localProjects, setLocalProjects] = useState<LocalProject[]>([]);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [currentPage, setCurrentPage] = useState<Page>("home");

  useEffect(() => {
    void auth.getSession().then((s) => {
      setSession(s);
      setIsLoadingSession(false);
    });
  }, []);

  useEffect(() => {
    if (!session) return;
    void host.getStatus().then(setHostState);
    void project.listLocalFolders().then(setLocalProjects);
  }, [session]);

  useEffect(() => {
    const offHost = events.onHostStateChanged(setHostState);
    const offPairing = events.onPairingStateChanged(setPairingState);
    return () => {
      offHost();
      offPairing();
    };
  }, []);

  const signIn = useCallback(async () => {
    await auth.startSignIn();
    const s = await auth.getSession();
    setSession(s);
  }, []);

  const signOut = useCallback(async () => {
    await auth.signOut();
    setSession(null);
    setHostState(null);
    setPairingState(null);
    setLocalProjects([]);
  }, []);

  const registerHost = useCallback(async () => {
    const state = await host.register();
    setHostState(state);
  }, []);

  const updatePermissionMode = useCallback(async (mode: PermissionMode) => {
    await host.updatePermissionMode(mode);
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await project.listLocalFolders();
    setLocalProjects(list);
  }, []);

  return (
    <AppCtx.Provider
      value={{
        session,
        hostState,
        pairingState,
        localProjects,
        isLoadingSession,
        currentPage,
        setPage: setCurrentPage,
        signIn,
        signOut,
        registerHost,
        updatePermissionMode,
        refreshProjects,
      }}
    >
      {children}
    </AppCtx.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
