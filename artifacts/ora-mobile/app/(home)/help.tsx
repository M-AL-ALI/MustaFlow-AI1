import * as WebBrowser from "expo-web-browser";
import {
  Brain,
  ChevronDown,
  FileText,
  Globe,
  Image as ImageIcon,
  Mic,
  Sparkles,
  TerminalSquare,
} from "lucide-react-native";
import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "@/components/Logo";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

const CAPABILITIES = [
  {
    icon: Sparkles,
    title: "Ask anything",
    body: "Brainstorm, draft, plan, and get clear answers in Instant or Deep Thinking mode.",
  },
  {
    icon: Globe,
    title: "Web search",
    body: "Ora can search the web and cite sources when you need current information.",
  },
  {
    icon: FileText,
    title: "Analyze files",
    body: "Attach PDFs, Word docs, spreadsheets, or CSVs and ask questions about them.",
  },
  {
    icon: ImageIcon,
    title: "Work with images",
    body: "Upload an image for analysis, or ask Ora to generate one for you.",
  },
  {
    icon: Brain,
    title: "Memory",
    body: "Ora remembers your profile and saved memories to personalize every reply.",
  },
  {
    icon: TerminalSquare,
    title: "Orax",
    body: "Connect a repository and run analyze or coding tasks against your codebase.",
  },
  {
    icon: Mic,
    title: "Voice",
    body: "Dictate messages by voice in your preferred language.",
  },
];

const FAQS = [
  {
    q: "What's the difference between Instant and Deep Thinking?",
    a: "Instant gives fast, concise answers. Deep Thinking reasons step by step for more thorough, considered responses and is available on paid plans.",
  },
  {
    q: "Where do my generated files go?",
    a: "Documents and images Ora creates are saved to your Library, where you can revisit them anytime.",
  },
  {
    q: "Is my data private?",
    a: "Your profile, memories, and conversations are tied to your account and are never shared with other users.",
  },
  {
    q: "How do limits work?",
    a: "Each plan includes a rolling window of messages and image generations. Your current usage is shown at the top of the Ora screen.",
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <Text
          style={{
            color: c.foreground,
            fontFamily: "Inter_600SemiBold",
            fontSize: 15,
            flex: 1,
          }}
        >
          {q}
        </Text>
        <ChevronDown
          size={18}
          color={c.mutedForeground}
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>
      {open && (
        <Text
          style={{
            color: c.mutedForeground,
            fontSize: 14,
            lineHeight: 20,
            marginTop: 10,
          }}
        >
          {a}
        </Text>
      )}
    </Card>
  );
}

export default function HelpScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Help" subtitle="Get the most out of Ora" />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 12,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <Card style={{ alignItems: "center", gap: 10, paddingVertical: 24 }}>
          <Logo size={36} />
          <Text
            style={{
              color: c.mutedForeground,
              fontSize: 14,
              textAlign: "center",
              lineHeight: 20,
              maxWidth: 300,
            }}
          >
            Ora is your AI companion for thinking, creating, and getting things done. Here's what
            you can do.
          </Text>
        </Card>

        <Text
          style={{
            color: c.foreground,
            fontFamily: "Inter_700Bold",
            fontSize: 16,
            marginTop: 4,
          }}
        >
          Capabilities
        </Text>
        {CAPABILITIES.map((cap) => {
          const Icon = cap.icon;
          return (
            <Card
              key={cap.title}
              style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  backgroundColor: c.muted,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon size={20} color={c.accentForeground} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: c.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 15,
                  }}
                >
                  {cap.title}
                </Text>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 14,
                    lineHeight: 20,
                    marginTop: 2,
                  }}
                >
                  {cap.body}
                </Text>
              </View>
            </Card>
          );
        })}

        <Text
          style={{
            color: c.foreground,
            fontFamily: "Inter_700Bold",
            fontSize: 16,
            marginTop: 8,
          }}
        >
          Frequently asked
        </Text>
        {FAQS.map((f) => (
          <FaqItem key={f.q} q={f.q} a={f.a} />
        ))}
      </ScrollView>
    </View>
  );
}
