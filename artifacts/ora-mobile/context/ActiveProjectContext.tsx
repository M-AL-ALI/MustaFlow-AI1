import React, { createContext, useCallback, useContext, useRef, useState } from "react";

interface ActiveProjectContextValue {
  activeProjectId: number | null;
  setActiveProjectId: (id: number | null) => void;
  pendingConversationId: number | null;
  setPendingConversationId: (id: number | null) => void;
  newConversationTick: number;
  triggerNewConversation: () => void;
}

const ActiveProjectContext = createContext<ActiveProjectContextValue>({
  activeProjectId: null,
  setActiveProjectId: () => {},
  pendingConversationId: null,
  setPendingConversationId: () => {},
  newConversationTick: 0,
  triggerNewConversation: () => {},
});

export function ActiveProjectProvider({ children }: { children: React.ReactNode }) {
  const [activeProjectId, setActiveProjectIdState] = useState<number | null>(null);
  const [pendingConversationId, setPendingConversationIdState] = useState<number | null>(null);
  const tickRef = useRef(0);
  const [newConversationTick, setNewConversationTick] = useState(0);

  const setActiveProjectId = useCallback((id: number | null) => {
    setActiveProjectIdState(id);
  }, []);

  const setPendingConversationId = useCallback((id: number | null) => {
    setPendingConversationIdState(id);
  }, []);

  const triggerNewConversation = useCallback(() => {
    tickRef.current += 1;
    setNewConversationTick(tickRef.current);
  }, []);

  return (
    <ActiveProjectContext.Provider
      value={{
        activeProjectId,
        setActiveProjectId,
        pendingConversationId,
        setPendingConversationId,
        newConversationTick,
        triggerNewConversation,
      }}
    >
      {children}
    </ActiveProjectContext.Provider>
  );
}

export function useActiveProject(): ActiveProjectContextValue {
  return useContext(ActiveProjectContext);
}
