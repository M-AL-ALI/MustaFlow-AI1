import { useCallback } from "react";

interface CheckpointHistoryNavigationOptions {
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
  setActiveTab,
  setAdvancedDataEnabled,
  setCheckpointFocusId,
  setMoreTabsExpanded,
  setChatDrawerOpen,
  isMobileLayout,
}: CheckpointHistoryNavigationOptions) {
  return useCallback(
    (checkpointId: number) => {
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
}
