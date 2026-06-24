import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import {
  BrainCircuit,
  Check,
  Download,
  ExternalLink,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Play,
  Sheet,
  Sparkles,
  Table2,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import { saveImageFromUrl } from "@/lib/files";
import { isSafeHttpUrl } from "@/lib/safe-url";
import type { OraAttachmentMeta, OraImage, OraMessage, OraSource, OraVideo } from "@/lib/types";

type Colors = ReturnType<typeof useColors>;

/**
 * Rich, web-parity extras rendered beneath an assistant reply: web-found media,
 * follow-up suggestions, a compact dataset summary, inline-image edit lineage,
 * and the saved-memory indicators / save-candidate prompt. Each sub-section is
 * self-gating (renders nothing when its data is absent), so the same component
 * is safe to drop under every assistant bubble.
 */
export function OraAssistantExtras({
  message,
  onSuggestion,
  onSaveMemory,
}: {
  message: OraMessage;
  onSuggestion: (text: string) => void;
  // Omitted in temporary chats so the save-to-memory prompt is hidden entirely.
  onSaveMemory?: (message: OraMessage) => Promise<void>;
}) {
  const c = useColors();
  return (
    <>
      <OraSourceCards sources={message.sources} c={c} />
      <OraImageGrid images={message.images} c={c} />
      <OraVideoCards videos={message.videos} c={c} />
      <OraDatasetCard result={message.datasetResult} c={c} />
      <OraImageLineage editInstruction={message.editInstruction} c={c} />
      <OraMemoryIndicators message={message} c={c} />
      <OraMemorySaveCandidate message={message} onSave={onSaveMemory} c={c} />
      <OraSuggestions suggestions={message.suggestions} onPress={onSuggestion} c={c} />
    </>
  );
}

function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function OraSourceCards({ sources, c }: { sources?: OraSource[]; c: Colors }) {
  const safeSources = (sources ?? []).filter((source) => isSafeHttpUrl(source.url));
  if (!safeSources.length) return null;
  return (
    <View style={{ marginTop: 10, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Globe size={12} color={c.mutedForeground} />
        <Text
          style={{
            color: c.mutedForeground,
            fontFamily: "Inter_500Medium",
            fontSize: 10,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            opacity: 0.6,
          }}
        >
          Sources
        </Text>
      </View>
      <View style={{ gap: 6 }}>
        {safeSources.map((source, index) => (
          <Pressable
            key={`${source.url}-${index}`}
            onPress={() => WebBrowser.openBrowserAsync(source.url)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: c.border + "99",
              backgroundColor: c.muted + "4D",
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(153,90,242,0.12)",
              }}
            >
              <Globe size={14} color="#995AF2" />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: c.foreground,
                  fontFamily: "Inter_500Medium",
                  fontSize: 12,
                  opacity: 0.9,
                }}
              >
                {source.title || source.url}
              </Text>
              <Text
                numberOfLines={1}
                style={{ color: c.mutedForeground, fontSize: 10, opacity: 0.7 }}
              >
                {sourceHostname(source.url)}
              </Text>
            </View>
            <ExternalLink size={14} color={c.mutedForeground} opacity={0.55} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/* ── Attachment chip (rendered inside the user bubble) ───────────────────── */

export function OraAttachmentChip({ attachment }: { attachment?: OraAttachmentMeta }) {
  const c = useColors();
  if (!attachment) return null;
  const Icon = attachment.isImage ? ImageIcon : attachment.isDataset ? Sheet : FileText;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        marginBottom: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 10,
        backgroundColor: "rgba(255,255,255,0.18)",
        alignSelf: "flex-start",
        maxWidth: "100%",
      }}
    >
      <Icon size={14} color={c.primaryForeground} />
      <Text numberOfLines={1} style={{ color: c.primaryForeground, fontSize: 12, flexShrink: 1 }}>
        {attachment.filename}
      </Text>
    </View>
  );
}

/* ── Web-found images ────────────────────────────────────────────────────── */

function OraImageGrid({ images, c }: { images?: OraImage[]; c: Colors }) {
  // Web-found image URLs are untrusted — drop any non-public/internal host before
  // an <Image> auto-fetches it (SSRF guard, mirrors the web gallery).
  const safe = (images ?? []).filter((img) => isSafeHttpUrl(img.url));
  if (safe.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 10 }}
      contentContainerStyle={{ gap: 8 }}
    >
      {safe.map((img, i) => (
        <WebImageThumb key={`${img.url}-${i}`} img={img} c={c} />
      ))}
    </ScrollView>
  );
}

function WebImageThumb({ img, c }: { img: OraImage; c: Colors }) {
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saveImageFromUrl(img.url);
      if (Platform.OS !== "web") Alert.alert("Saved", "Image saved to your photo library.");
    } catch (err) {
      Alert.alert(
        "Couldn't save image",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSaving(false);
    }
  }, [img.url, saving]);

  // img.url already passed isSafeHttpUrl in OraImageGrid; only open img.source
  // when it is itself a safe public link, otherwise fall back to the image URL.
  const linkTarget = img.source && isSafeHttpUrl(img.source) ? img.source : img.url;
  return (
    <Pressable
      onPress={() => WebBrowser.openBrowserAsync(linkTarget)}
      accessibilityRole="imagebutton"
      accessibilityLabel={img.title || "Web image"}
      style={{ width: 150 }}
    >
      <Image
        source={{ uri: img.url }}
        style={{ width: 150, height: 110, borderRadius: 12, backgroundColor: c.muted }}
        contentFit="cover"
        transition={150}
      />
      <Pressable
        onPress={save}
        disabled={saving}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Save image"
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          padding: 6,
          borderRadius: 999,
          backgroundColor: "rgba(0,0,0,0.55)",
        }}
      >
        {saving ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Download size={13} color="#fff" />
        )}
      </Pressable>
      {!!img.title && (
        <Text numberOfLines={2} style={{ color: c.mutedForeground, fontSize: 11, marginTop: 4 }}>
          {img.title}
        </Text>
      )}
    </Pressable>
  );
}

/* ── Web-found video link cards ──────────────────────────────────────────── */

function OraVideoCards({ videos, c }: { videos?: OraVideo[]; c: Colors }) {
  // Untrusted web-search results — only keep cards whose watch URL is a safe
  // public http(s) link; gate the thumbnail URL independently.
  const safe = (videos ?? []).filter((v) => isSafeHttpUrl(v.url));
  if (safe.length === 0) return null;
  return (
    <View style={{ marginTop: 10, gap: 8 }}>
      {safe.map((v, i) => {
        const thumb = v.thumbnailUrl && isSafeHttpUrl(v.thumbnailUrl) ? v.thumbnailUrl : null;
        return (
          <Pressable
            key={`${v.url}-${i}`}
            onPress={() => WebBrowser.openBrowserAsync(v.url)}
            accessibilityRole="link"
            accessibilityLabel={v.title || "Open video"}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              padding: 8,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: c.cardBorder,
              backgroundColor: c.muted,
            }}
          >
            {thumb ? (
              <Image
                source={{ uri: thumb }}
                style={{ width: 64, height: 48, borderRadius: 8, backgroundColor: c.background }}
                contentFit="cover"
              />
            ) : (
              <View
                style={{
                  width: 64,
                  height: 48,
                  borderRadius: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: c.background,
                }}
              >
                <Play size={18} color={c.accentForeground} />
              </View>
            )}
            <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 13, flex: 1 }}>
              {v.title || v.url}
            </Text>
            <ExternalLink size={15} color={c.mutedForeground} />
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Dataset analysis summary (compact) ──────────────────────────────────── */

function OraDatasetCard({ result, c }: { result?: OraMessage["datasetResult"]; c: Colors }) {
  if (!result) return null;
  const hasShape = result.rowCount != null || result.columnCount != null;
  if (!hasShape && !result.truncated) return null;
  const parts: string[] = [];
  if (result.rowCount != null) parts.push(`${result.rowCount.toLocaleString()} rows`);
  if (result.columnCount != null) parts.push(`${result.columnCount.toLocaleString()} columns`);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        marginTop: 10,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.cardBorder,
        backgroundColor: c.muted,
      }}
    >
      <Table2 size={15} color={c.accentForeground} />
      <Text style={{ color: c.foreground, fontSize: 12, flex: 1 }}>
        {parts.join(" × ") || "Dataset analyzed"}
        {result.truncated ? "  ·  sampled" : ""}
      </Text>
    </View>
  );
}

/* ── Inline image edit lineage ───────────────────────────────────────────── */

function OraImageLineage({ editInstruction, c }: { editInstruction?: string; c: Colors }) {
  if (!editInstruction) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
      <GitBranch size={13} color={c.mutedForeground} />
      <Text numberOfLines={2} style={{ color: c.mutedForeground, fontSize: 12, flex: 1 }}>
        Edited from original · {editInstruction}
      </Text>
    </View>
  );
}

/* ── Saved-memory indicators (read-only) ─────────────────────────────────── */

function OraMemoryIndicators({ message, c }: { message: OraMessage; c: Colors }) {
  const used = message.memoriesUsed ?? [];
  const superseded = (message.memorySupersededTitles ?? []).filter((t) => t.trim().length > 0);
  const showUsed = used.length > 0;
  const showSuperseded = message.memorySaved && superseded.length > 0;
  if (!showUsed && !showSuperseded) return null;
  return (
    <View style={{ marginTop: 8, gap: 4 }}>
      {showUsed && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <BrainCircuit size={13} color={c.mutedForeground} />
          <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
            Based on {used.length} saved {used.length === 1 ? "memory" : "memories"}
          </Text>
        </View>
      )}
      {showSuperseded && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Check size={13} color={c.mutedForeground} />
          <Text numberOfLines={2} style={{ color: c.mutedForeground, fontSize: 12, flex: 1 }}>
            Updated your memory{" "}
            {superseded.length === 1
              ? `"${superseded[0]}"`
              : `(${superseded.length} earlier memories)`}
          </Text>
        </View>
      )}
    </View>
  );
}

/* ── Save-this-to-memory prompt ──────────────────────────────────────────── */

function OraMemorySaveCandidate({
  message,
  onSave,
  c,
}: {
  message: OraMessage;
  onSave?: (message: OraMessage) => Promise<void>;
  c: Colors;
}) {
  const [saving, setSaving] = useState(false);

  if (message.memorySaved) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
        <Check size={13} color={c.accentForeground} />
        <Text style={{ color: c.accentForeground, fontSize: 12 }}>Saved to memory</Text>
      </View>
    );
  }

  if (!message.memorySaveCandidate || !onSave) return null;

  const save = async () => {
    if (saving || !onSave) return;
    setSaving(true);
    try {
      await onSave(message);
    } catch (err) {
      Alert.alert("Couldn't save", err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.cardBorder,
        backgroundColor: c.muted,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Sparkles size={14} color={c.accentForeground} />
        <Text style={{ color: c.foreground, fontSize: 12, fontFamily: "Inter_600SemiBold" }}>
          Save this to memory?
        </Text>
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{message.memorySaveCandidate}</Text>
      <Pressable
        onPress={save}
        disabled={saving}
        accessibilityRole="button"
        accessibilityLabel="Save this to memory"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          alignSelf: "flex-start",
          paddingVertical: 6,
          paddingHorizontal: 14,
          borderRadius: 999,
          backgroundColor: c.primary,
        }}
      >
        {saving ? (
          <ActivityIndicator size="small" color={c.primaryForeground} />
        ) : (
          <Text
            style={{ color: c.primaryForeground, fontSize: 12, fontFamily: "Inter_600SemiBold" }}
          >
            Save
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/* ── Follow-up suggestion chips ──────────────────────────────────────────── */

function OraSuggestions({
  suggestions,
  onPress,
  c,
}: {
  suggestions?: string[];
  onPress: (text: string) => void;
  c: Colors;
}) {
  const items = (suggestions ?? []).filter((s) => s.trim().length > 0);
  if (items.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      {items.map((s, i) => (
        <Pressable
          key={`${s}-${i}`}
          onPress={() => onPress(s)}
          accessibilityRole="button"
          accessibilityLabel={s}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingVertical: 7,
            paddingHorizontal: 12,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: c.cardBorder,
            backgroundColor: c.background,
          }}
        >
          <Sparkles size={12} color={c.accentForeground} />
          <Text style={{ color: c.foreground, fontSize: 12 }}>{s}</Text>
        </Pressable>
      ))}
    </View>
  );
}
