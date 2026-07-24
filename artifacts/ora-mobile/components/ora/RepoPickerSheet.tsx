/**
 * Ora GitHub repo picker (mobile) — read-only analysis session selector.
 * Mirrors the website's OraRepoPickerDialog. Ora can never write to GitHub.
 */
import { GitBranch, Lock, X } from "lucide-react-native";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import {
  listGithubRepos,
  selectRepoSession,
  type OraGithubRepoSummary,
  type OraRepoSessionSummary,
} from "@/lib/api";

export interface RepoPickerSheetProps {
  visible: boolean;
  connected: boolean;
  onClose: () => void;
  onSelected: (session: OraRepoSessionSummary) => void;
  onNeedConnect: () => void;
  colors: {
    background: string;
    card: string;
    border: string;
    foreground: string;
    mutedForeground: string;
    accent: string;
  };
}

export function RepoPickerSheet({
  visible,
  connected,
  onClose,
  onSelected,
  onNeedConnect,
  colors: c,
}: RepoPickerSheetProps) {
  const [repos, setRepos] = useState<OraGithubRepoSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !connected) return;
    setLoading(true);
    setError(null);
    listGithubRepos()
      .then(setRepos)
      .catch(() => setError("Could not load your repositories."))
      .finally(() => setLoading(false));
  }, [visible, connected]);

  const filtered = (repos ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}>
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: "80%",
            padding: 16,
            gap: 12,
          }}
        >
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <GitBranch size={16} color={c.accent} />
              <Text style={{ color: c.foreground, fontSize: 15, fontWeight: "700" }}>
                Analyze a GitHub repo
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close repo picker">
              <X size={18} color={c.mutedForeground} />
            </Pressable>
          </View>

          {!connected ? (
            <View style={{ gap: 10, paddingVertical: 8 }}>
              <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
                Connect your GitHub account first — Settings → GitHub. Ora only reads your code; it
                can never commit or push.
              </Text>
              <Pressable
                onPress={onNeedConnect}
                style={{
                  backgroundColor: c.accent,
                  borderRadius: 10,
                  paddingVertical: 10,
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#000", fontSize: 13, fontWeight: "700" }}>
                  Open Settings
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder="Filter repositories…"
                placeholderTextColor={c.mutedForeground}
                style={{
                  borderWidth: 1,
                  borderColor: c.border,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  color: c.foreground,
                  fontSize: 14,
                }}
              />
              {loading && (
                <View style={{ paddingVertical: 20, alignItems: "center" }}>
                  <ActivityIndicator />
                </View>
              )}
              {error && (
                <Text style={{ color: "#f87171", fontSize: 13, paddingVertical: 8 }}>{error}</Text>
              )}
              {!loading && !error && (
                <FlatList
                  data={filtered}
                  keyExtractor={(r) => r.fullName}
                  style={{ flexGrow: 0 }}
                  ListEmptyComponent={
                    <Text
                      style={{
                        color: c.mutedForeground,
                        fontSize: 13,
                        textAlign: "center",
                        paddingVertical: 16,
                      }}
                    >
                      No repositories match.
                    </Text>
                  }
                  renderItem={({ item }) => (
                    <Pressable
                      disabled={selecting !== null}
                      onPress={() => {
                        setSelecting(item.fullName);
                        setError(null);
                        selectRepoSession(item.owner, item.name)
                          .then((session) => {
                            onSelected(session);
                            onClose();
                          })
                          .catch(() => setError("Could not open that repository."))
                          .finally(() => setSelecting(null));
                      }}
                      style={{
                        paddingVertical: 10,
                        paddingHorizontal: 8,
                        borderRadius: 10,
                        opacity: selecting && selecting !== item.fullName ? 0.5 : 1,
                      }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        {selecting === item.fullName ? (
                          <ActivityIndicator size="small" />
                        ) : (
                          <GitBranch size={14} color={c.mutedForeground} />
                        )}
                        <Text
                          numberOfLines={1}
                          style={{ color: c.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}
                        >
                          {item.fullName}
                        </Text>
                        {item.private && <Lock size={12} color={c.mutedForeground} />}
                      </View>
                      {item.description ? (
                        <Text
                          numberOfLines={1}
                          style={{ color: c.mutedForeground, fontSize: 12, marginLeft: 22 }}
                        >
                          {item.description}
                        </Text>
                      ) : null}
                    </Pressable>
                  )}
                />
              )}
              <Text style={{ color: c.mutedForeground, fontSize: 11 }}>
                Read-only analysis — Ora reads and explains, it never writes to your repo.
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
