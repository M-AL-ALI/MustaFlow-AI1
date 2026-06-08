import * as WebBrowser from "expo-web-browser";
import React from "react";
import MarkdownDisplay from "react-native-markdown-display";

import { useColors } from "@/hooks/useColors";

/** Themed markdown renderer for Ora replies. */
export function Markdown({ children }: { children: string }) {
  const c = useColors();

  const styles = {
    body: {
      color: c.foreground,
      fontFamily: "Inter_400Regular",
      fontSize: 15,
      lineHeight: 22,
    },
    heading1: {
      color: c.foreground,
      fontFamily: "Inter_700Bold",
      fontSize: 20,
      marginTop: 8,
      marginBottom: 4,
    },
    heading2: {
      color: c.foreground,
      fontFamily: "Inter_700Bold",
      fontSize: 18,
      marginTop: 8,
      marginBottom: 4,
    },
    heading3: {
      color: c.foreground,
      fontFamily: "Inter_600SemiBold",
      fontSize: 16,
      marginTop: 6,
      marginBottom: 2,
    },
    strong: { fontFamily: "Inter_700Bold", color: c.foreground },
    em: { fontStyle: "italic" as const },
    link: { color: c.accentForeground, textDecorationLine: "underline" as const },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { color: c.foreground, marginVertical: 2 },
    code_inline: {
      backgroundColor: c.muted,
      color: c.accentForeground,
      borderRadius: 4,
      paddingHorizontal: 4,
      fontFamily: "Inter_400Regular",
    },
    code_block: {
      backgroundColor: c.muted,
      color: c.foreground,
      borderRadius: c.radius,
      padding: 12,
      fontFamily: "Inter_400Regular",
      fontSize: 13,
    },
    fence: {
      backgroundColor: c.muted,
      color: c.foreground,
      borderRadius: c.radius,
      padding: 12,
      fontFamily: "Inter_400Regular",
      fontSize: 13,
    },
    blockquote: {
      backgroundColor: c.muted,
      borderLeftColor: c.primary,
      borderLeftWidth: 3,
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 4,
    },
    hr: { backgroundColor: c.border, height: 1 },
    table: { borderColor: c.border, borderWidth: 1, borderRadius: 6 },
    th: { padding: 6 },
    td: { padding: 6, borderColor: c.border },
  };

  return (
    <MarkdownDisplay
      style={styles as never}
      onLinkPress={(url) => {
        if (/^https?:\/\//.test(url)) {
          void WebBrowser.openBrowserAsync(url);
        }
        return false;
      }}
    >
      {children}
    </MarkdownDisplay>
  );
}
