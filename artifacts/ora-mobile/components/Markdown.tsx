import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import React from "react";
import { Text } from "react-native";
import MarkdownDisplay, { type ASTNode } from "react-native-markdown-display";

import { useColors } from "@/hooks/useColors";
import { isSafeHttpUrl } from "@/lib/safe-url";

/**
 * Auto-link bare URLs and unwrap backtick-wrapped URLs so plain URLs in an Ora
 * reply become tappable. `react-native-markdown-display` only links explicit
 * `[label](url)` / `<url>` syntax, so a bare URL (or one trapped in inline
 * code) is otherwise dead text. We:
 *   1. unwrap `` `https://…` `` → `https://…` so it can be linked, then
 *   2. wrap bare URLs in `<…>` autolink syntax, but only OUTSIDE existing
 *      markdown links, angle-autolinks, and code spans so we never corrupt
 *      already-valid syntax.
 */
function linkifyMarkdown(src: string): string {
  // 1. Unwrap inline-code-wrapped URLs.
  const out = src.replace(/`(https?:\/\/[^\s`]+)`/gi, "$1");

  // 2. Auto-link bare URLs in the gaps between protected spans.
  const protect = /(\[[^\]]*\]\([^)]*\))|(<https?:\/\/[^>]+>)|(```[\s\S]*?```)|(`[^`]*`)/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = protect.exec(out)) !== null) {
    result += autolinkGap(out.slice(last, m.index));
    result += m[0];
    last = protect.lastIndex;
  }
  result += autolinkGap(out.slice(last));
  return result;
}

function autolinkGap(text: string): string {
  return text.replace(/https?:\/\/[^\s<>()[\]]+/gi, (url) => {
    const trail = url.match(/[.,;:!?]+$/);
    if (trail) {
      const clean = url.slice(0, url.length - trail[0].length);
      return `<${clean}>${trail[0]}`;
    }
    return `<${url}>`;
  });
}

/** Themed markdown renderer for Ora replies. */
export function Markdown({ children }: { children: string }) {
  const c = useColors();

  const styles = {
    body: {
      color: c.foreground + "E6",
      fontFamily: "Inter_400Regular",
      fontSize: 15,
      lineHeight: 24,
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

  // Custom link rule: tappable link (opens the in-app browser) followed by a
  // small inline Copy affordance. The copy icon renders as a Text glyph so it
  // sits inline next to the link without breaking the text flow.
  const rules = {
    link: (node: ASTNode, children: React.ReactNode) => {
      const href = (node.attributes?.href as string) ?? "";
      const safe = isSafeHttpUrl(href);
      return (
        <Text key={node.key}>
          <Text
            style={styles.link}
            onPress={safe ? () => void WebBrowser.openBrowserAsync(href) : undefined}
          >
            {children}
          </Text>
          {safe ? (
            <Text
              onPress={() => void Clipboard.setStringAsync(href)}
              accessibilityLabel="Copy link"
              suppressHighlighting
            >
              {"  "}
              <Feather name="copy" size={12} color={c.mutedForeground} />
            </Text>
          ) : null}
        </Text>
      );
    },
  };

  return (
    <MarkdownDisplay
      style={styles as never}
      rules={rules}
      onLinkPress={(url: string) => {
        if (isSafeHttpUrl(url)) {
          void WebBrowser.openBrowserAsync(url);
        }
        return false;
      }}
    >
      {linkifyMarkdown(children)}
    </MarkdownDisplay>
  );
}
