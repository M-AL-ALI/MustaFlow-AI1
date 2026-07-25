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
}: {
  conversations: OraConversationSummary[];
  projects: OraProjectSummary[];
  activeProjectId: number | null;
  onSelect: (id: number) => void;
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [activeProjectId]);

  const allRecent = useMemo(
    () => sortOraHomeRecentConversations(conversations, activeProjectId),
    [activeProjectId, conversations],
  );

  if (allRecent.length === 0) return null;

  const visible = expanded ? allRecent : allRecent.slice(0, ORA_HOME_RECENT_LIMIT);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <View
      accessibilityLabel="Recent conversations"
      style={{ width: "100%", maxWidth: 560, marginTop: 18 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
          paddingHorizontal: 4,
        }}
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
        <Text style={{ color: colors.mutedForeground, fontSize: 11 }}>{allRecent.length}</Text>
      </View>

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
                <MessageSquare size={16} color={colors.mutedForeground} style={{ marginTop: 2 }} />
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
                    ? `${projectName}${conversation.preview ? ` · ${conversation.preview}` : ""}`
                    : conversation.preview || "Continue this conversation"}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {allRecent.length > ORA_HOME_RECENT_LIMIT ? (
        <Pressable
          onPress={() => setExpanded((current) => !current)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show fewer conversations" : "Show more conversations"}
          accessibilityState={{ expanded }}
          style={{
            alignSelf: "flex-start",
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 4,
            paddingVertical: 10,
          }}
        >
          {expanded ? (
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
            {expanded ? "Show less" : "Show more"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
