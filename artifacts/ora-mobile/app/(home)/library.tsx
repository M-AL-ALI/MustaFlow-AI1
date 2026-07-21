import { useAuth } from "@clerk/expo";
import { Image } from "expo-image";
import { Download, FileText, FolderOpen, HardDrive, History, Share2, Trash2 } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SignInWall } from "@/components/SignInWall";
import { VersionHistorySheet } from "@/components/ora/VersionHistorySheet";
import { Card, EmptyState, Loading } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { API_BASE, deleteAsset, getAssets, listProjects } from "@/lib/api";
import { saveAsset } from "@/lib/files";
import type { OraAsset, OraProjectSummary } from "@/lib/types";

/** Tri-state Library scope: everything, unfiled ("Personal"), or one project. */
type LibraryProjectFilter = "all" | "personal" | number;

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function LibraryScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isSignedIn } = useAuth();
  const [assets, setAssets] = useState<OraAsset[]>([]);
  const [storage, setStorage] = useState<{ usedBytes: number; capBytes: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyAssetId, setHistoryAssetId] = useState<number | null>(null);
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  const [projectFilter, setProjectFilter] = useState<LibraryProjectFilter>("all");

  const reload = useCallback(async () => {
    try {
      const res = await getAssets(projectFilter === "all" ? undefined : projectFilter);
      setAssets(res.assets ?? []);
      setStorage(res.storage ?? null);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [projectFilter]);

  useEffect(() => {
    if (!isSignedIn) return;
    void reload();
  }, [reload, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) return;
    // Project chips are best-effort; the Library still works without them.
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [isSignedIn]);

  if (!isSignedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScreenHeader title="Library" subtitle="Files & images Ora created" showBackToOra />
        <SignInWall
          title="Sign in for Library"
          description="Your generated files and images are stored with your account."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Library" subtitle="Files & images Ora created" showBackToOra />
      {loading ? (
        <Loading label="Loading library…" />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 16,
            gap: 12,
            paddingBottom: insets.bottom + 24,
          }}
        >
          {storage && (
            <Card
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <HardDrive size={20} color={c.accentForeground} />
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: c.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 14,
                  }}
                >
                  Storage
                </Text>
                <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                  {formatBytes(storage.usedBytes)} of {formatBytes(storage.capBytes)} used
                </Text>
              </View>
            </Card>
          )}

          {projects.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ flexDirection: "row", gap: 8 }}
            >
              {(
                [
                  { key: "all" as const, label: "All" },
                  { key: "personal" as const, label: "Personal" },
                  ...projects.map((p) => ({ key: p.id, label: p.name })),
                ] as Array<{ key: LibraryProjectFilter; label: string }>
              ).map((chip) => {
                const selected = projectFilter === chip.key;
                return (
                  <Pressable
                    key={String(chip.key)}
                    onPress={() => setProjectFilter(chip.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Filter library: ${chip.label}`}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      borderRadius: 999,
                      backgroundColor: selected ? c.primary : c.muted,
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        color: selected ? c.primaryForeground : c.foreground,
                        fontSize: 13,
                        fontFamily: "Inter_500Medium",
                        maxWidth: 160,
                      }}
                    >
                      {chip.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          {assets.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title={projectFilter === "all" ? "Your library is empty" : "Nothing here yet"}
              subtitle={
                projectFilter === "all"
                  ? "Generated documents and images from your Ora chats will appear here."
                  : projectFilter === "personal"
                    ? "Files and images not filed under a project will appear here."
                    : "Files and images created in this project will appear here."
              }
            />
          ) : (
            assets.map((a) => (
              <AssetCard
                key={a.id}
                asset={a}
                onDelete={() => setAssets((prev) => prev.filter((x) => x.id !== a.id))}
                onShowHistory={a.kind === "file" ? () => setHistoryAssetId(a.id) : undefined}
              />
            ))
          )}
        </ScrollView>
      )}
      <VersionHistorySheet
        assetId={historyAssetId}
        visible={historyAssetId != null}
        onClose={() => setHistoryAssetId(null)}
        onRestored={() => void reload()}
      />
    </View>
  );
}

function AssetCard({
  asset,
  onDelete,
  onShowHistory,
}: {
  asset: OraAsset;
  onDelete?: () => void;
  onShowHistory?: () => void;
}) {
  const c = useColors();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isImage = asset.kind === "image";

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const outcome = await saveAsset(asset);
      if (outcome === "image-saved") {
        Alert.alert("Saved", "Image saved to your photo library.");
      }
    } catch (err) {
      Alert.alert(
        "Couldn't save file",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSaving(false);
    }
  }, [asset, saving]);

  const handleDelete = useCallback(() => {
    Alert.alert("Delete asset?", "This will permanently remove it from your library.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            await deleteAsset(asset.id);
            onDelete?.();
          } catch (err) {
            Alert.alert("Error", err instanceof Error ? err.message : "Could not delete.");
          } finally {
            setDeleting(false);
          }
        },
      },
    ]);
  }, [asset.id, onDelete]);

  return (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {isImage ? (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            backgroundColor: c.muted,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <Image
            source={{
              uri: `${API_BASE}/api/ora/assets/${asset.id}/download`,
            }}
            style={{ width: 48, height: 48 }}
            contentFit="cover"
            transition={150}
          />
        </View>
      ) : (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            backgroundColor: c.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <FileText size={22} color={c.accentForeground} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{
            color: c.foreground,
            fontFamily: "Inter_500Medium",
            fontSize: 14,
          }}
        >
          {asset.fileName}
        </Text>
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
          {asset.format?.toUpperCase()} · {formatBytes(asset.sizeBytes)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {onShowHistory ? (
          <Pressable
            onPress={onShowHistory}
            disabled={saving || deleting}
            hitSlop={8}
            accessibilityLabel="View version history"
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: c.muted,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <History size={16} color={c.accentForeground} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={handleSave}
          disabled={saving || deleting}
          hitSlop={8}
          accessibilityLabel={isImage ? "Save image" : "Share file"}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: c.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {saving ? (
            <ActivityIndicator size="small" color={c.mutedForeground} />
          ) : isImage ? (
            <Download size={16} color={c.accentForeground} />
          ) : (
            <Share2 size={16} color={c.accentForeground} />
          )}
        </Pressable>
        <Pressable
          onPress={handleDelete}
          disabled={saving || deleting}
          hitSlop={8}
          accessibilityLabel="Delete asset"
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: c.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {deleting ? (
            <ActivityIndicator size="small" color={c.mutedForeground} />
          ) : (
            <Trash2 size={16} color="#ef4444" />
          )}
        </Pressable>
      </View>
    </Card>
  );
}
