import { useCallback, useEffect, useState } from "react";

interface CheckpointHistoryNavigationOptions {
  activeTab: string;
  setActiveTab: (tab: "checkpoints") => void;
  setAdvancedDataEnabled: (enabled: boolean) => void;
  setCheckpointFocusId: (checkpointId: number) => void;
  setMoreTabsExpanded: (expanded: boolean) => void;
  setChatDrawerOpen: (open: boolean) => void;
  isMobileLayout: boolean;
}

/**
 * Opens the restore-capable Version History workspace surface and targets the
 * checkpoint represented by an inline build result.
 */
export function useCheckpointHistoryNavigation({
  activeTab,
  setActiveTab,
  setAdvancedDataEnabled,
  setCheckpointFocusId,
  setMoreTabsExpanded,
  setChatDrawerOpen,
  isMobileLayout,
}: CheckpointHistoryNavigationOptions) {
  const [pendingCheckpointId, setPendingCheckpointId] = useState<number | null>(null);

  const openCheckpointHistory = useCallback(
    (checkpointId: number) => {
      setPendingCheckpointId(checkpointId);
      setCheckpointFocusId(checkpointId);
      setAdvancedDataEnabled(true);
      setMoreTabsExpanded(true);
      setActiveTab("checkpoints");
      if (isMobileLayout) setChatDrawerOpen(false);
    },
    [
      isMobileLayout,
      setActiveTab,
      setAdvancedDataEnabled,
      setChatDrawerOpen,
      setCheckpointFocusId,
      setMoreTabsExpanded,
    ],
  );

  // A freshly completed report can be replaced while its authoritative event
  // history refetches. Keep the navigation intent alive until the lazy-mounted
  // history surface confirms that it focused the requested checkpoint.
  useEffect(() => {
    if (pendingCheckpointId === null || activeTab === "checkpoints") return;
    setAdvancedDataEnabled(true);
    setMoreTabsExpanded(true);
    setActiveTab("checkpoints");
    if (isMobileLayout) setChatDrawerOpen(false);
  }, [
    activeTab,
    isMobileLayout,
    pendingCheckpointId,
    setActiveTab,
    setAdvancedDataEnabled,
    setChatDrawerOpen,
    setMoreTabsExpanded,
  ]);

  const completeCheckpointHistoryNavigation = useCallback((checkpointId: number) => {
    setPendingCheckpointId((current) => (current === checkpointId ? null : current));
  }, []);

  return {
    openCheckpointHistory,
    completeCheckpointHistoryNavigation,
    pendingCheckpointId,
  };
}
