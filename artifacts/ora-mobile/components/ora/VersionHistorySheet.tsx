import { Check, Download, History, RotateCcw, X } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { listAssetVersions, restoreAssetVersion } from "@/lib/api";
import { saveAsset } from "@/lib/files";
import type { OraAssetVersion } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Bottom-sheet listing the revision chain of a generated file (website
 * parity with OraVersionHistoryDialog). Versions render newest-first with a
 * Current badge; older versions can be downloaded or restored. Restore never
 * rewrites history — the server creates a NEW head version — so after a
 * restore the sheet reloads against the new head id and notifies the caller
 * via onRestored(newAssetId).
 */
export function VersionHistorySheet({
  assetId,
  visible,
  onClose,
  onRestored,
}: {
  assetId: number | null;
  visible: boolean;
  onClose: () => void;
  onRestored?: (newAssetId: number) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<OraAssetVersion[]>([]);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAssetVersions(id);
      // Server returns v1-first; show newest-first.
      setVersions([...res.versions].reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load version history.");
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible || assetId == null) return;
    void load(assetId);
  }, [visible, assetId, load]);

  const handleDownload = useCallback(
    async (version: OraAssetVersion) => {
      if (downloadingId != null) return;
      setDownloadingId(version.id);
      try {
        await saveAsset({
          id: version.id,
          kind: "file",
          fileName: version.fileName,
          mimeType: version.mimeType,
          format: version.format,
          prompt: "",
          sizeBytes: version.sizeBytes,
          createdAt: version.createdAt,
        });
      } catch (err) {
        Alert.alert(
          "Couldn't download version",
          err instanceof Error ? err.message : "Something went wrong.",
        );
      } finally {
        setDownloadingId(null);
      }
    },
    [downloadingId],
  );

  const handleRestore = useCallback(
    async (version: OraAssetVersion) => {
      if (restoringId != null) return;
      setRestoringId(version.id);
      try {
        const res = await restoreAssetVersion(version.id);
        onRestored?.(res.assetId);
        Alert.alert(
          "Version restored",
          `Version ${version.versionNumber} is now the current version of ${res.fileName}.`,
        );
        // Reload the chain against the NEW head so the badge moves.
        await load(res.assetId);
      } catch (err) {
        Alert.alert(
          "Restore failed",
          err instanceof Error ? err.message : "Something went wrong.",
        );
      } finally {
        setRestoringId(null);
      }
    },
    [restoringId, onRestored, load],
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }}
        onPress={onClose}
        accessibilityLabel="Close version history"
      />
      <View
        style={{
          backgroundColor: c.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          maxHeight: "75%",
          paddingBottom: insets.bottom + 12,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 18,
            paddingTop: 16,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <History size={18} color={c.accentForeground} />
          <Text
            style={{
              color: c.foreground,
              fontFamily: "Inter_600SemiBold",
              fontSize: 16,
              flex: 1,
            }}
          >
            Version history
          </Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
            <X size={20} color={c.mutedForeground} />
          </Pressable>
        </View>

        {loading ? (
          <View style={{ padding: 32, alignItems: "center" }}>
            <ActivityIndicator color={c.mutedForeground} />
          </View>
        ) : error ? (
          <View style={{ padding: 24 }}>
            <Text style={{ color: "#ef4444", fontSize: 13, textAlign: "center" }}>{error}</Text>
          </View>
        ) : versions.length === 0 ? (
          <View style={{ padding: 24 }}>
            <Text style={{ color: c.mutedForeground, fontSize: 13, textAlign: "center" }}>
              No version history for this file yet.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
            {versions.map((v) => (
              <View
                key={v.id}
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: v.isCurrent ? c.accentForeground + "55" : c.border,
                  backgroundColor: c.card,
                  padding: 12,
                  gap: 8,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text
                    style={{
                      color: c.foreground,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 13,
                    }}
                  >
                    Version {v.versionNumber}
                  </Text>
                  {v.isCurrent && (
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        backgroundColor: c.accentForeground + "20",
                        borderRadius: 999,
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                      }}
                    >
                      <Check size={11} color={c.accentForeground} />
                      <Text style={{ color: c.accentForeground, fontSize: 11 }}>Current</Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }} />
                  <Text style={{ color: c.mutedForeground, fontSize: 11 }}>
                    {formatBytes(v.sizeBytes)}
                  </Text>
                </View>
                <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 12 }}>
                  {v.fileName} · {formatDate(v.createdAt)}
                </Text>
                {!!v.editSummary && (
                  <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 12 }}>
                    {v.editSummary}
                  </Text>
                )}
                <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
                  <Pressable
                    onPress={() => void handleDownload(v)}
                    disabled={downloadingId != null || restoringId != null}
                    accessibilityRole="button"
                    accessibilityLabel={`Download version ${v.versionNumber}`}
                    style={{
                      flex: 1,
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      borderRadius: 9,
                      paddingVertical: 8,
                      borderWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    {downloadingId === v.id ? (
                      <ActivityIndicator size="small" color={c.mutedForeground} />
                    ) : (
                      <Download size={14} color={c.accentForeground} />
                    )}
                    <Text style={{ color: c.foreground, fontSize: 12 }}>Download</Text>
                  </Pressable>
                  {!v.isCurrent && (
                    <Pressable
                      onPress={() => void handleRestore(v)}
                      disabled={restoringId != null || downloadingId != null}
                      accessibilityRole="button"
                      accessibilityLabel={`Restore version ${v.versionNumber}`}
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        borderRadius: 9,
                        paddingVertical: 8,
                        backgroundColor: c.muted,
                      }}
                    >
                      {restoringId === v.id ? (
                        <ActivityIndicator size="small" color={c.mutedForeground} />
                      ) : (
                        <RotateCcw size={14} color={c.accentForeground} />
                      )}
                      <Text style={{ color: c.foreground, fontSize: 12 }}>Restore</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
