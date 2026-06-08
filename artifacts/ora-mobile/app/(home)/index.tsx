import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import {
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
  type AudioRecorder,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { useFocusEffect } from "expo-router";
import {
  ArrowUp,
  Copy,
  Download,
  FileText,
  Gauge,
  History,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Plus,
  Share2,
  Sparkles,
  Square,
  Volume2,
  X,
  Zap,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Markdown } from "@/components/Markdown";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState, Pill } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { saveGeneratedFile, saveImageFromUrl } from "@/lib/files";
import {
  analyzeDataset,
  analyzeDocument,
  analyzeImage,
  createConversation,
  deleteConversation,
  getConversation,
  getOraSession,
  getPreferences,
  listConversations,
  saveConversationMessages,
  sendChat,
  synthesizeSpeech,
  transcribeAudio,
  uploadFile,
} from "@/lib/api";
import type {
  Attachment,
  OraConversationSummary,
  OraMessage,
  OraMode,
  OraSession,
} from "@/lib/types";

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DATASET_TYPES = ["csv", "xlsx", "xls"];

function attachmentKind(fileType: string, isImage: boolean): Attachment["kind"] {
  if (isImage) return "image";
  if (DATASET_TYPES.includes(fileType.toLowerCase())) return "dataset";
  return "document";
}

function isImageFile(mimeType?: string): boolean {
  return !!mimeType && mimeType.toLowerCase().startsWith("image/");
}

export default function OraChatScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<OraMessage>>(null);

  const [session, setSession] = useState<OraSession | null>(null);
  const [messages, setMessages] = useState<OraMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<OraMode>("instant");
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [showConversations, setShowConversations] = useState(false);
  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);

  const [voiceLang, setVoiceLang] = useState("en");
  const [autoReadReplies, setAutoReadReplies] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const playerRef = useRef<AudioPlayer | null>(null);

  const loadPreferences = useCallback(() => {
    getPreferences()
      .then((p) => {
        if (p.voiceLang) setVoiceLang(p.voiceLang);
        setAutoReadReplies(!!p.autoReadReplies);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getOraSession()
      .then(setSession)
      .catch(() => setSession(null));
    loadPreferences();
  }, [loadPreferences]);

  // Re-read preferences whenever the chat screen regains focus so changes made
  // in Settings (e.g. "Read replies aloud", voice language) apply immediately
  // without an app restart — drawer screens stay mounted between navigations.
  useFocusEffect(
    useCallback(() => {
      loadPreferences();
    }, [loadPreferences]),
  );

  useEffect(() => {
    return () => {
      try {
        playerRef.current?.remove();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const persist = useCallback(
    async (msgs: OraMessage[]) => {
      try {
        let convId = conversationId;
        if (!convId) {
          const title = msgs.find((m) => m.role === "user")?.content.slice(0, 60) || "New chat";
          const created = await createConversation(title, null);
          convId = created.conversation.id;
          setConversationId(convId);
        }
        await saveConversationMessages(convId, msgs);
      } catch {
        /* persistence is best-effort */
      }
    },
    [conversationId],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attachment) || sending) return;

    const userMsg: OraMessage = { id: uid(), role: "user", content: text };
    const pending: OraMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      pending: true,
    };
    const history = messages
      .filter((m) => !m.pending && !m.error)
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    const next = [...messages, userMsg, pending];
    setMessages(next);
    setInput("");
    setSending(true);
    scrollToEnd();

    const currentAttachment = attachment;
    setAttachment(null);

    try {
      let assistant: OraMessage;
      if (currentAttachment) {
        const prompt = text || "Please analyze this attachment.";
        let reply: string;
        if (currentAttachment.kind === "image") {
          reply = (await analyzeImage(currentAttachment.ref, prompt, history)).reply;
        } else if (currentAttachment.kind === "dataset") {
          reply = (await analyzeDataset(currentAttachment.ref, prompt, history)).reply;
        } else {
          reply = (await analyzeDocument(currentAttachment.ref, prompt, history)).reply;
        }
        assistant = { id: pending.id, role: "assistant", content: reply };
      } else {
        const res = await sendChat({
          message: text,
          messages: history,
          mode,
          referenceSavedMemories: true,
          referenceChatHistory: true,
        });
        assistant = {
          id: pending.id,
          role: "assistant",
          content: res.reply,
          sources: res.sources,
          imageUrl: res.imageUrl,
          imageId: res.imageId,
          file:
            res.fileName && res.fileData && res.mimeType
              ? {
                  fileName: res.fileName,
                  fileData: res.fileData,
                  mimeType: res.mimeType,
                }
              : undefined,
        };
        if (res.msgCount != null && res.msgLimit != null) {
          setSession((s) => (s ? { ...s, msgCount: res.msgCount!, msgLimit: res.msgLimit! } : s));
        }
      }
      const finalMsgs = next.map((m) => (m.id === pending.id ? assistant : m));
      setMessages(finalMsgs);
      scrollToEnd();
      void persist(finalMsgs);
      if (autoReadRef.current && assistant.content.trim()) {
        void speakRef.current(assistant);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong. Try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pending.id ? { ...m, pending: false, error: true, content: msg } : m,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [input, attachment, sending, messages, mode, scrollToEnd, persist]);

  const startRecording = useCallback(async () => {
    if (recording || transcribing) return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      setRecording(false);
    }
  }, [recording, transcribing, recorder]);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(false);
    setTranscribing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await recorder.stop();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) return;
      const text = await transcribeAudio(uri, "m4a", voiceLang);
      const clean = text.trim();
      if (clean) {
        setInput((prev) => (prev.trim() ? `${prev.trim()} ${clean}` : clean));
      }
    } catch {
      /* surfaced by absence of inserted text */
    } finally {
      setTranscribing(false);
    }
  }, [recording, recorder, voiceLang]);

  const speak = useCallback(
    async (message: OraMessage) => {
      try {
        playerRef.current?.remove();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (speakingId === message.id) {
        setSpeakingId(null);
        return;
      }
      setSpeakingId(message.id);
      try {
        const dataUri = await synthesizeSpeech(message.content, "nova", voiceLang);
        const base64 = dataUri.split(",")[1] ?? "";
        const fileUri = `${FileSystem.cacheDirectory}ora-tts-${Date.now()}.mp3`;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
        const player = createAudioPlayer({ uri: fileUri });
        playerRef.current = player;
        player.addListener("playbackStatusUpdate", (status) => {
          if (status.didJustFinish) {
            setSpeakingId((cur) => (cur === message.id ? null : cur));
            try {
              player.remove();
            } catch {
              /* ignore */
            }
            if (playerRef.current === player) playerRef.current = null;
          }
        });
        player.play();
      } catch {
        setSpeakingId((cur) => (cur === message.id ? null : cur));
      }
    },
    [speakingId, voiceLang],
  );

  const speakRef = useRef(speak);
  speakRef.current = speak;
  const autoReadRef = useRef(autoReadReplies);
  autoReadRef.current = autoReadReplies;

  const handleAttach = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "image/*",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/csv",
          "text/plain",
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const file = result.assets[0];
      setUploading(true);
      const isImage = (file.mimeType ?? "").startsWith("image/");
      const res = await uploadFile({
        uri: file.uri,
        name: file.name,
        type: file.mimeType ?? "application/octet-stream",
      });
      const ref = res.imageRef ?? res.fileRef;
      if (!ref) throw new Error("Upload failed");
      setAttachment({
        ref,
        kind: attachmentKind(res.fileType, isImage || res.kind === "image"),
        filename: res.filename ?? file.name,
        fileType: res.fileType,
      });
    } catch {
      /* surfaced by absence of chip */
    } finally {
      setUploading(false);
    }
  }, []);

  const newChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setAttachment(null);
    setInput("");
  }, []);

  const openConversations = useCallback(async () => {
    setShowConversations(true);
    setLoadingConversations(true);
    try {
      setConversations(await listConversations());
    } catch {
      setConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  const loadConversation = useCallback(
    async (id: number) => {
      setShowConversations(false);
      try {
        const detail = await getConversation(id);
        setConversationId(id);
        setMessages(
          (detail.messages ?? []).map((m) => ({
            ...m,
            id: m.id || uid(),
          })),
        );
        scrollToEnd();
      } catch {
        /* ignore */
      }
    },
    [scrollToEnd],
  );

  const removeConversation = useCallback(
    async (id: number) => {
      try {
        await deleteConversation(id);
        setConversations((prev) => prev.filter((x) => x.id !== id));
        if (id === conversationId) newChat();
      } catch {
        /* ignore */
      }
    },
    [conversationId, newChat],
  );

  const usageText = session
    ? `${session.msgCount}/${session.msgLimit} messages${session.tier ? ` · ${session.tier}` : ""}`
    : "Loading…";

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader
        title="Ora"
        subtitle={usageText}
        right={
          <View style={{ flexDirection: "row", gap: 4 }}>
            <Pressable onPress={openConversations} hitSlop={8} style={{ padding: 6 }}>
              <History size={22} color={c.foreground} />
            </Pressable>
            <Pressable onPress={newChat} hitSlop={8} style={{ padding: 6 }}>
              <Plus size={22} color={c.foreground} />
            </Pressable>
          </View>
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 44}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{
            padding: 16,
            gap: 14,
            flexGrow: 1,
          }}
          onContentSizeChange={scrollToEnd}
          ListEmptyComponent={
            <View style={{ flex: 1, justifyContent: "center" }}>
              <EmptyState
                icon={Sparkles}
                title="Ask Ora anything"
                subtitle="Brainstorm ideas, analyze files and images, search the web, or generate documents — all in one conversation."
              />
            </View>
          }
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              speaking={speakingId === item.id}
              onSpeak={() => speak(item)}
            />
          )}
        />

        {/* Composer */}
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: c.border,
            backgroundColor: c.background,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: insets.bottom + 10,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pill
              label="Instant"
              icon={Zap}
              active={mode === "instant"}
              onPress={() => setMode("instant")}
            />
            <Pill
              label="Deep"
              icon={Gauge}
              active={mode === "deep"}
              onPress={() => setMode("deep")}
            />
          </View>

          {attachment && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                alignSelf: "flex-start",
                backgroundColor: c.muted,
                borderRadius: 999,
                paddingVertical: 6,
                paddingHorizontal: 12,
              }}
            >
              {attachment.kind === "image" ? (
                <ImageIcon size={14} color={c.accentForeground} />
              ) : (
                <FileText size={14} color={c.accentForeground} />
              )}
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, maxWidth: 200 }}>
                {attachment.filename}
              </Text>
              <Pressable onPress={() => setAttachment(null)} hitSlop={8}>
                <X size={14} color={c.mutedForeground} />
              </Pressable>
            </View>
          )}

          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            {!recording && (
              <Pressable
                onPress={handleAttach}
                disabled={uploading}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: c.radius,
                  backgroundColor: c.secondary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={c.mutedForeground} />
                ) : (
                  <Paperclip size={20} color={c.mutedForeground} />
                )}
              </Pressable>
            )}
            <Pressable
              onPress={recording ? stopRecording : startRecording}
              disabled={transcribing}
              style={{
                width: 44,
                height: 44,
                borderRadius: c.radius,
                backgroundColor: recording ? c.destructive : c.secondary,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {transcribing ? (
                <ActivityIndicator size="small" color={c.mutedForeground} />
              ) : recording ? (
                <Square size={18} color={c.primaryForeground} fill={c.primaryForeground} />
              ) : (
                <Mic size={20} color={c.mutedForeground} />
              )}
            </Pressable>
            {recording ? (
              <RecordingIndicator recorder={recorder} />
            ) : (
              <>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder="Message Ora…"
                  placeholderTextColor={c.mutedForeground}
                  multiline
                  style={{
                    flex: 1,
                    maxHeight: 120,
                    minHeight: 44,
                    backgroundColor: c.card,
                    borderWidth: 1,
                    borderColor: c.border,
                    borderRadius: c.radius,
                    paddingHorizontal: 14,
                    paddingTop: 12,
                    paddingBottom: 12,
                    color: c.foreground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 15,
                  }}
                />
                <Pressable
                  onPress={handleSend}
                  disabled={sending || (!input.trim() && !attachment)}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: c.radius,
                    backgroundColor:
                      sending || (!input.trim() && !attachment) ? c.secondary : c.primary,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={c.primaryForeground} />
                  ) : (
                    <ArrowUp
                      size={20}
                      color={!input.trim() && !attachment ? c.mutedForeground : c.primaryForeground}
                    />
                  )}
                </Pressable>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>

      <ConversationsModal
        visible={showConversations}
        loading={loadingConversations}
        conversations={conversations}
        activeId={conversationId}
        onClose={() => setShowConversations(false)}
        onSelect={loadConversation}
        onDelete={removeConversation}
      />
    </View>
  );
}

const WAVEFORM_BAR_COUNT = 28;
const METERING_FLOOR_DB = -50;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function RecordingIndicator({ recorder }: { recorder: AudioRecorder }) {
  const c = useColors();
  const state = useAudioRecorderState(recorder, 90);
  const [levels, setLevels] = useState<number[]>(() => Array(WAVEFORM_BAR_COUNT).fill(0));

  const metering = state.metering;
  useEffect(() => {
    const db = typeof metering === "number" ? metering : METERING_FLOOR_DB;
    const norm = Math.max(0, Math.min(1, (db - METERING_FLOOR_DB) / -METERING_FLOOR_DB));
    const eased = Math.pow(norm, 0.6);
    setLevels((prev) => [...prev.slice(1), eased]);
  }, [metering]);

  return (
    <View
      style={{
        flex: 1,
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: c.radius,
        paddingHorizontal: 14,
      }}
    >
      <View
        style={{
          flex: 1,
          height: 28,
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
        }}
      >
        {levels.map((level, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: Math.max(3, level * 26),
              borderRadius: 2,
              backgroundColor: c.destructive,
              opacity: 0.55 + level * 0.45,
            }}
          />
        ))}
      </View>
      <Text
        style={{
          color: c.mutedForeground,
          fontFamily: "Inter_500Medium",
          fontSize: 13,
          fontVariant: ["tabular-nums"],
          minWidth: 44,
          textAlign: "right",
        }}
      >
        {formatElapsed(state.durationMillis)}
      </Text>
    </View>
  );
}

function MessageBubble({
  message,
  speaking,
  onSpeak,
}: {
  message: OraMessage;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const c = useColors();
  const isUser = message.role === "user";
  const [savingFile, setSavingFile] = useState(false);
  const [savingImage, setSavingImage] = useState(false);

  const copy = () => Clipboard.setStringAsync(message.content);

  const handleSaveFile = useCallback(async () => {
    if (!message.file || savingFile) return;
    setSavingFile(true);
    try {
      const outcome = await saveGeneratedFile(message.file);
      if (outcome === "image-saved") {
        Alert.alert("Saved", "Image saved to your photo library.");
      }
    } catch (err) {
      Alert.alert(
        "Couldn't save file",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSavingFile(false);
    }
  }, [message.file, savingFile]);

  const handleSaveImage = useCallback(async () => {
    if (!message.imageUrl || savingImage) return;
    setSavingImage(true);
    try {
      await saveImageFromUrl(message.imageUrl);
      if (Platform.OS !== "web") {
        Alert.alert("Saved", "Image saved to your photo library.");
      }
    } catch (err) {
      Alert.alert(
        "Couldn't save image",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSavingImage(false);
    }
  }, [message.imageUrl, savingImage]);

  if (isUser) {
    return (
      <View style={{ alignItems: "flex-end" }}>
        <View
          style={{
            backgroundColor: c.primary,
            borderRadius: 18,
            borderBottomRightRadius: 4,
            paddingHorizontal: 14,
            paddingVertical: 10,
            maxWidth: "86%",
          }}
        >
          <Text
            style={{
              color: c.primaryForeground,
              fontFamily: "Inter_400Regular",
              fontSize: 15,
              lineHeight: 21,
            }}
          >
            {message.content}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ alignItems: "flex-start", maxWidth: "92%" }}>
      <View
        style={{
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.cardBorder,
          borderRadius: 18,
          borderBottomLeftRadius: 4,
          paddingHorizontal: 14,
          paddingVertical: 10,
          width: "100%",
        }}
      >
        {message.pending ? (
          <ActivityIndicator size="small" color={c.mutedForeground} />
        ) : message.error ? (
          <Text style={{ color: c.destructive, fontSize: 14 }}>{message.content}</Text>
        ) : (
          <>
            <Markdown>{message.content}</Markdown>

            {message.imageUrl && (
              <View style={{ marginTop: 10 }}>
                <Image
                  source={{ uri: message.imageUrl }}
                  style={{
                    width: "100%",
                    aspectRatio: 1,
                    borderRadius: 12,
                  }}
                  contentFit="cover"
                  transition={200}
                />
                <Pressable
                  onPress={handleSaveImage}
                  disabled={savingImage}
                  hitSlop={8}
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    borderRadius: 999,
                    backgroundColor: "rgba(0,0,0,0.55)",
                  }}
                >
                  {savingImage ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Download size={14} color="#fff" />
                  )}
                  <Text style={{ color: "#fff", fontSize: 12 }}>Save</Text>
                </Pressable>
              </View>
            )}

            {message.file && (
              <Pressable
                onPress={handleSaveFile}
                disabled={savingFile}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 10,
                  backgroundColor: c.muted,
                }}
              >
                <FileText size={18} color={c.accentForeground} />
                <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, flex: 1 }}>
                  {message.file.fileName}
                </Text>
                {savingFile ? (
                  <ActivityIndicator size="small" color={c.mutedForeground} />
                ) : isImageFile(message.file.mimeType) ? (
                  <Download size={16} color={c.accentForeground} />
                ) : (
                  <Share2 size={16} color={c.accentForeground} />
                )}
              </Pressable>
            )}

            {message.sources && message.sources.length > 0 && (
              <View style={{ marginTop: 10, gap: 6 }}>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 12,
                  }}
                >
                  Sources
                </Text>
                {message.sources.map((s, i) => (
                  <Pressable
                    key={`${s.url}-${i}`}
                    onPress={() => WebBrowser.openBrowserAsync(s.url)}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        color: c.accentForeground,
                        fontSize: 13,
                        textDecorationLine: "underline",
                      }}
                    >
                      {s.title || s.url}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}
      </View>
      {!message.pending && !message.error && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            marginTop: 6,
            marginLeft: 4,
          }}
        >
          <Pressable
            onPress={copy}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Copy size={13} color={c.mutedForeground} />
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Copy</Text>
          </Pressable>
          {!!message.content && (
            <Pressable
              onPress={onSpeak}
              hitSlop={8}
              style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            >
              <Volume2 size={13} color={speaking ? c.accentForeground : c.mutedForeground} />
              <Text
                style={{
                  color: speaking ? c.accentForeground : c.mutedForeground,
                  fontSize: 12,
                }}
              >
                {speaking ? "Stop" : "Listen"}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function ConversationsModal({
  visible,
  loading,
  conversations,
  activeId,
  onClose,
  onSelect,
  onDelete,
}: {
  visible: boolean;
  loading: boolean;
  conversations: OraConversationSummary[];
  activeId: number | null;
  onClose: () => void;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 12,
            maxHeight: "75%",
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
              marginBottom: 12,
            }}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 18,
              paddingBottom: 12,
            }}
          >
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_700Bold",
                fontSize: 18,
              }}
            >
              Conversations
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={c.mutedForeground} />
            </Pressable>
          </View>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginVertical: 32 }} />
          ) : conversations.length === 0 ? (
            <EmptyState icon={History} title="No conversations yet" />
          ) : (
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12 }}>
              {conversations.map((conv) => (
                <View
                  key={conv.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: c.radius,
                    backgroundColor: conv.id === activeId ? c.accent : "transparent",
                  }}
                >
                  <Pressable style={{ flex: 1 }} onPress={() => onSelect(conv.id)}>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_500Medium",
                        fontSize: 15,
                      }}
                    >
                      {conv.title || "Untitled"}
                    </Text>
                    {conv.preview ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          color: c.mutedForeground,
                          fontSize: 13,
                          marginTop: 2,
                        }}
                      >
                        {conv.preview}
                      </Text>
                    ) : null}
                  </Pressable>
                  <Pressable onPress={() => onDelete(conv.id)} hitSlop={8}>
                    <X size={18} color={c.mutedForeground} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
