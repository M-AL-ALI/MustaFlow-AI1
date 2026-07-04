import React from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { LEGAL_SECTIONS } from "@workspace/ora-contracts";

interface LegalPrivacyModalProps {
  visible: boolean;
  onClose: () => void;
}

export function LegalPrivacyModal({ visible, onClose }: LegalPrivacyModalProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 20,
            paddingTop: insets.top + 16,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <Text
            style={{
              color: c.foreground,
              fontFamily: "Inter_700Bold",
              fontSize: 17,
            }}
          >
            Legal &amp; Privacy
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text
              style={{
                color: c.accentForeground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 15,
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 24,
            gap: 16,
          }}
        >
          {LEGAL_SECTIONS.map(({ heading, body }) => (
            <View key={heading} style={{ gap: 4 }}>
              <Text
                style={{
                  color: c.foreground,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 13,
                }}
              >
                {heading}
              </Text>
              <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 20 }}>
                {body}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
