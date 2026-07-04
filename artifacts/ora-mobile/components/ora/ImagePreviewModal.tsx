import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { Check, Copy, Download, Share2, X } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { saveImageFromUrl, shareImageFromUrl } from "@/lib/files";

type ActionState = "idle" | "saving" | "sharing" | "copying";

/**
 * Full-screen preview for a single chat image (a generated image, or an
 * uploaded image attachment). The image is centered in `contain` mode so it is
 * never cropped. A bottom action row exposes Save to Photos, Share, and Copy
 * link; a top-right × closes the modal.
 *
 * The `source` may be a remote (possibly auth-gated) URL, a `data:` URI, or a
 * local `file://` URI. Save/Share delegate to the shared helpers in lib/files
 * (which download auth-gated URLs to a temp file first and request photo-library
 * permission only on Save). Copy link writes the canonical URL — or the data
 * URI for a purely local base64 image — to the clipboard.
 */
export function ImagePreviewModal({
  source,
  onClose,
}: {
  source: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [action, setAction] = useState<ActionState>("idle");
  const [feedback, setFeedback] = useState<string | null>(null);

  // Reset transient state whenever a new image is opened (or the modal closes).
  useEffect(() => {
    setAction("idle");
    setFeedback(null);
  }, [source]);

  const showFeedback = useCallback((message: string) => {
    setFeedback(message);
    // Auto-dismiss so the toast never lingers over the next interaction.
    setTimeout(() => setFeedback(null), 2500);
  }, []);

  const handleSave = useCallback(async () => {
    if (!source || action !== "idle") return;
    setAction("saving");
    try {
      await saveImageFromUrl(source);
      showFeedback("Saved to your photo library.");
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Could not save the image.");
    } finally {
      setAction("idle");
    }
  }, [source, action, showFeedback]);

  const handleShare = useCallback(async () => {
    if (!source || action !== "idle") return;
    setAction("sharing");
    try {
      await shareImageFromUrl(source);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Could not share the image.");
    } finally {
      setAction("idle");
    }
  }, [source, action, showFeedback]);

  const handleCopyLink = useCallback(async () => {
    if (!source || action !== "idle") return;
    setAction("copying");
    try {
      await Clipboard.setStringAsync(source);
      showFeedback("Link copied to clipboard.");
    } catch {
      showFeedback("Could not copy the link.");
    } finally {
      setAction("idle");
    }
  }, [source, action, showFeedback]);

  return (
    <Modal
      visible={!!source}
      transparent={false}
      animationType="fade"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {/* Close (×) — top-right */}
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close image preview"
          style={{
            position: "absolute",
            top: insets.top + 8,
            right: 12,
            zIndex: 10,
            width: 40,
            height: 40,
            borderRadius: 999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(255,255,255,0.14)",
          }}
        >
          <X size={22} color="#fff" />
        </Pressable>

        {/* Centered image */}
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {source && (
            <Image
              source={{ uri: source }}
              style={{ width: "100%", height: "100%" }}
              contentFit="contain"
              transition={150}
            />
          )}
        </View>

        {/* Toast feedback */}
        {feedback && (
          <View
            style={{
              position: "absolute",
              left: 24,
              right: 24,
              bottom: insets.bottom + 110,
              alignItems: "center",
            }}
          >
            <Text
              style={{
                color: "#fff",
                fontSize: 13,
                textAlign: "center",
                backgroundColor: "rgba(0,0,0,0.75)",
                paddingVertical: 8,
                paddingHorizontal: 14,
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              {feedback}
            </Text>
          </View>
        )}

        {/* Bottom action row */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-around",
            alignItems: "flex-start",
            paddingTop: 14,
            paddingBottom: insets.bottom + 14,
            paddingHorizontal: 12,
            gap: 8,
          }}
        >
          <ActionButton
            icon={
              action === "saving" ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Download size={22} color="#fff" />
              )
            }
            label="Save to Photos"
            onPress={handleSave}
            disabled={action !== "idle"}
          />
          <ActionButton
            icon={
              action === "sharing" ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Share2 size={22} color="#fff" />
              )
            }
            label="Share"
            onPress={handleShare}
            disabled={action !== "idle"}
          />
          <ActionButton
            icon={
              action === "copying" ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Copy size={22} color="#fff" />
              )
            }
            label="Copy link"
            onPress={handleCopyLink}
            disabled={action !== "idle"}
          />
        </View>
      </View>
    </Modal>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flex: 1,
        alignItems: "center",
        gap: 6,
        paddingVertical: 8,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 999,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "rgba(255,255,255,0.14)",
        }}
      >
        {icon}
      </View>
      <Text style={{ color: "#fff", fontSize: 11, textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
}
