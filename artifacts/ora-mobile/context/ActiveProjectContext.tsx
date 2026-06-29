import React, { createContext, useCallback, useContext, useState } from "react";

interface ActiveProjectContextValue {
  activeProjectId: number | null;
  setActiveProjectId: (id: number | null) => void;
}

const ActiveProjectContext = createContext<ActiveProjectContextValue>({
  activeProjectId: null,
  setActiveProjectId: () => {},
});

export function ActiveProjectProvider({ children }: { children: React.ReactNode }) {
  const [activeProjectId, setActiveProjectIdState] = useState<number | null>(null);
  const setActiveProjectId = useCallback((id: number | null) => {
    setActiveProjectIdState(id);
  }, []);
  return (
    <ActiveProjectContext.Provider value={{ activeProjectId, setActiveProjectId }}>
      {children}
    </ActiveProjectContext.Provider>
  );
}

export function useActiveProject(): ActiveProjectContextValue {
  return useContext(ActiveProjectContext);
}
