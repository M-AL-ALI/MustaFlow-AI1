import { Image } from "expo-image";
import { FileText, FolderOpen, HardDrive } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { Card, EmptyState, Loading } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { getAssets } from "@/lib/api";
import type { OraAsset } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function LibraryScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [assets, setAssets] = useState<OraAsset[]>([]);
  const [storage, setStorage] = useState<{ usedBytes: number; capBytes: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await getAssets();
      setAssets(res.assets ?? []);
      setStorage(res.storage ?? null);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Library" subtitle="Files & images Ora created" />
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

          {assets.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="Your library is empty"
              subtitle="Generated documents and images from your Ora chats will appear here."
            />
          ) : (
            assets.map((a) => (
              <Card key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                {a.kind === "image" ? (
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
                        uri: `${process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : ""}/api/ora/assets/${a.id}/download`,
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
                    {a.fileName}
                  </Text>
                  <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                    {a.format?.toUpperCase()} · {formatBytes(a.sizeBytes)}
                  </Text>
                </View>
              </Card>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}
