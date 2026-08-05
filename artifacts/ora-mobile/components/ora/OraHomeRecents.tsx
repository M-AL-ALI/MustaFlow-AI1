import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, ChevronUp, FolderOpen, MessageSquare } from "lucide-react-native";
import { ORA_HOME_RECENT_LIMIT, sortOraHomeRecentConversations } from "@workspace/ora-contracts";
import { useColors } from "@/hooks/useColors";
import type { OraConversationSummary, OraProjectSummary } from "@/lib/types";

export function OraHomeRecents({
  conversations,
  projects,
  activeProjectId,
  onSelect,
  collapsedByDefault = false,
}: {
  conversations: OraConversationSummary[];
  projects: OraProjectSummary[];
  activeProjectId: number | null;
  onSelect: (id: number) => void;
  collapsedByDefault?: boolean;
}) {
  const colors = useColors();
  const [listOpen, setListOpen] = useState(!collapsedByDefault);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setListOpen(!collapsedByDefault);
    setShowAll(false);
  }, [activeProjectId, collapsedByDefault]);

  const allRecent = useMemo(
    () => sortOraHomeRecentConversations(conversations, activeProjectId),
    [activeProjectId, conversations],
  );

  if (allRecent.length === 0) return null;

  const visible = showAll ? allRecent : allRecent.slice(0, ORA_HOME_RECENT_LIMIT);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <View
      accessibilityLabel="Recent conversations"
      style={{ width: "100%", maxWidth: 560, marginTop: 16 }}
    >
      <Pressable
        onPress={() => setListOpen((current) => !current)}
        accessibilityRole="button"
        accessibilityLabel={listOpen ? "Hide recent conversations" : "Show recent conversations"}
        accessibilityState={{ expanded: listOpen }}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          paddingHorizontal: 4,
          paddingVertical: 8,
          borderRadius: 8,
          backgroundColor: pressed ? colors.accent : "transparent",
        })}
      >
        <Text
          style={{
            color: colors.foreground,
            fontSize: 14,
            fontFamily: "Inter_600SemiBold",
          }}
        >
          Recent conversations
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>{allRecent.length}</Text>
          {listOpen ? (
            <ChevronUp size={14} color={colors.mutedForeground} />
          ) : (
            <ChevronDown size={14} color={colors.mutedForeground} />
          )}
        </View>
      </Pressable>

      {listOpen ? (
        <>
          <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border }}>
            {visible.map((conversation, index) => {
              const projectName =
                conversation.projectId == null ? null : projectNames.get(conversation.projectId);
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => onSelect(conversation.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open conversation ${conversation.title || "Untitled"}`}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: 10,
                    paddingHorizontal: 4,
                    paddingVertical: 10,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderColor: colors.border,
                    backgroundColor: pressed ? colors.accent : "transparent",
                  })}
                >
                  {projectName ? (
                    <FolderOpen size={16} color={colors.mutedForeground} style={{ marginTop: 2 }} />
                  ) : (
                    <MessageSquare
                      size={16}
                      color={colors.mutedForeground}
                      style={{ marginTop: 2 }}
                    />
                  )}
                  <View style={{ minWidth: 0, flex: 1 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: colors.foreground,
                        fontSize: 14,
                        fontFamily: "Inter_500Medium",
                      }}
                    >
                      {conversation.title || "Untitled"}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}
                    >
                      {projectName
                        ? `${projectName}${conversation.preview ? ` - ${conversation.preview}` : ""}`
                        : conversation.preview || "Continue this conversation"}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {allRecent.length > ORA_HOME_RECENT_LIMIT ? (
            <Pressable
              onPress={() => setShowAll((current) => !current)}
              accessibilityRole="button"
              accessibilityLabel={showAll ? "Show fewer conversations" : "Show more conversations"}
              accessibilityState={{ expanded: showAll }}
              style={{
                alignSelf: "flex-start",
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 4,
                paddingVertical: 10,
              }}
            >
              {showAll ? (
                <ChevronUp size={14} color={colors.mutedForeground} />
              ) : (
                <ChevronDown size={14} color={colors.mutedForeground} />
              )}
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontSize: 12,
                  fontFamily: "Inter_500Medium",
                }}
              >
                {showAll ? "Show less" : "Show more"}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
