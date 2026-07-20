import { X } from "lucide-react-native";
import { ActivityIndicator, Modal, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";

import { useColors } from "@/hooks/useColors";

type WebViewModule = typeof import("react-native-webview");
let webViewModule: WebViewModule | null | undefined;

/**
 * react-native-webview is a native module. On an older native build (one
 * created before it was added) the native side is missing, so a static
 * top-level import would throw at module-load time and crash the entire app.
 * Load it lazily and cache the outcome (including the "unavailable" case) so
 * the app always launches and only in-app file preview degrades — callers
 * fall back to the native share sheet ("Open with…").
 */
function getWebViewModule(): WebViewModule | null {
  if (webViewModule === undefined) {
    try {
      webViewModule = require("react-native-webview") as WebViewModule;
    } catch {
      webViewModule = null;
    }
  }
  return webViewModule;
}

/**
 * In-app preview of Office files (docx/pptx/xlsx) and PDFs relies on iOS
 * WebKit's built-in document rendering. Android WebView cannot render local
 * Office/PDF files, so Android callers use the share-sheet fallback instead.
 */
export function canViewFileInApp(): boolean {
  return Platform.OS === "ios" && getWebViewModule() !== null;
}

/**
 * Full-screen in-app preview for a generated/edited file that has been
 * materialized to a local cache URI. iOS-only (see canViewFileInApp); the
 * WebView renders docx/pptx/xlsx/pdf natively via WebKit.
 */
export function GeneratedFileViewer({
  uri,
  fileName,
  onClose,
}: {
  uri: string | null;
  fileName: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const mod = getWebViewModule();
  if (!mod) return null;
  const WebView = mod.WebView;

  return (
    <Modal
      visible={!!uri}
      transparent={false}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingTop: insets.top + 8,
            paddingBottom: 10,
            paddingHorizontal: 14,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: c.foreground,
              fontSize: 14,
              fontFamily: "Inter_600SemiBold",
            }}
          >
            {fileName}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close file preview"
            style={{
              width: 34,
              height: 34,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.muted,
            }}
          >
            <X size={18} color={c.foreground} />
          </Pressable>
        </View>
        {uri && (
          <WebView
            source={{ uri }}
            originWhitelist={["file://*"]}
            allowFileAccess
            allowingReadAccessToURL={FileSystem.cacheDirectory ?? undefined}
            startInLoadingState
            renderLoading={() => (
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: c.background,
                }}
              >
                <ActivityIndicator size="large" color={c.mutedForeground} />
              </View>
            )}
            style={{ flex: 1, backgroundColor: c.background }}
          />
        )}
      </View>
    </Modal>
  );
}
