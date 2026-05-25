import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Send,
  Plus,
  X,
  GripVertical,
  Trash2,
  Sparkles,
  Paperclip,
  Mic,
  Paintbrush2,
  Image as ImageIcon,
  Layers2,
  Navigation,
  Cpu,
  Zap,
  LayoutTemplate,
  Clock,
  Lock,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetAgentRouting, useUpdateProject } from "@workspace/api-client-react";
import { PlanTemplatesPicker } from "./plan-templates-picker";
import { PlanHistoryPanel } from "./plan-history";
import type { StructuredPlan } from "./plan-card";

type AgentMode = "lite" | "eco" | "power" | "pro";
type AgentType = "planning" | "task" | "main";

const AGENT_OPTIONS: {
  value: AgentType;
  label: string;
  description: string;
  icon: React.ElementType;
  className: string;
}[] = [
  {
    value: "planning",
    label: "Planning",
    description: "Shows a plan before building — use this for big or complex changes.",
    icon: Navigation,
    className: "text-blue-400 border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/15",
  },
  {
    value: "task",
    label: "Task",
    description: "Stage changes for your review before applying",
    icon: Cpu,
    className: "text-amber-400 border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15",
  },
  {
    value: "main",
    label: "Main",
    description: "Direct edit — changes apply immediately",
    icon: Zap,
    className: "text-green-400 border-green-500/30 bg-green-500/10 hover:bg-green-500/15",
  },
];

interface QueueRow {
  id: string;
  text: string;
}

type SpeechRecognitionResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};
function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type ComposerAttachment =
  | {
      kind: "image";
      url: string;
      alt?: string;
      generated?: boolean;
    }
  | {
      kind: "file";
      uploadId: number;
      name: string;
      mime: string;
      size: number;
    };

interface QueueComposerProps {
  projectId: number;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  subscriptionTier?: "free" | "pro" | "team";
  planMode: boolean;
  onPlanModeChange: (v: boolean) => void;
  runInBackground: boolean;
  onRunInBackgroundChange: (v: boolean) => void;
  variantMode: boolean;
  onVariantModeChange: (v: boolean) => void;
  disabled: boolean;
  /** The currently running task ID — when set alongside `disabled`, shows a Stop build button. */
  activeTaskId?: number | null;
  /** Called when the user clicks the Stop build button. */
  onStopBuild?: () => void;
  onSingleSend: (
    content: string,
    agentIntent?: "converse" | "plan" | "build",
    attachments?: ComposerAttachment[],
  ) => void;
  onBatchStarted: (batchId: string, totalCount: number) => void;
  promptValue?: string;
  onPromptValueChange?: (v: string) => void;
  onAgentIdentityChange?: (identity: AgentType) => void;
}

export function QueueComposer({
  projectId,
  agentMode,
  onAgentModeChange,
  subscriptionTier: _subscriptionTier = "free",
  planMode,
  onPlanModeChange,
  runInBackground: _runInBackground,
  onRunInBackgroundChange,
  variantMode,
  onVariantModeChange,
  disabled,
  activeTaskId,
  onStopBuild,
  onSingleSend,
  onBatchStarted,
  promptValue,
  onPromptValueChange,
  onAgentIdentityChange,
}: QueueComposerProps) {
  const lsKey = `mustaflow_agent_type_${projectId}`;
  const [agentType, setAgentTypeRaw] = useState<AgentType>(() => {
    const stored = localStorage.getItem(lsKey);
    return (stored as AgentType | null) ?? "main";
  });

  const { mutate: updateProject } = useUpdateProject();

  const setAgentType = useCallback(
    (type: AgentType) => {
      setAgentTypeRaw(type);
      localStorage.setItem(lsKey, type);
      onPlanModeChange(type === "planning");
      onRunInBackgroundChange(type === "task");
      onAgentIdentityChange?.(type);
      // Persist to server so the preference survives across devices/sessions
      updateProject({ id: projectId, data: { defaultAgent: type } });
    },
    [
      lsKey,
      onPlanModeChange,
      onRunInBackgroundChange,
      onAgentIdentityChange,
      updateProject,
      projectId,
    ],
  );

  // Debounced prompt for routing hint
  const [debouncedPrompt, setDebouncedPrompt] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onPromptForRouting = useCallback((text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedPrompt(text), 600);
  }, []);

  const { data: routingHint } = useGetAgentRouting(
    projectId,
    { prompt: debouncedPrompt },
    {
      query: {
        queryKey: ["agent-routing", projectId, debouncedPrompt],
        enabled: debouncedPrompt.length >= 10,
        staleTime: 30_000,
      },
    },
  );

  const [rows, setRows] = useState<QueueRow[]>([{ id: crypto.randomUUID(), text: "" }]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imagePanelOpen, setImagePanelOpen] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showPlanHistory, setShowPlanHistory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const uploadFile = useCallback(
    async (file: File): Promise<ComposerAttachment | null> => {
      setUploadingCount((c) => c + 1);
      try {
        // Images keep the legacy /api/storage/uploads flow so the existing
        // image attachment rendering keeps working.
        if (file.type.startsWith("image/")) {
          const meta = await fetch("/api/storage/uploads/request-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
          });
          if (!meta.ok) throw new Error("Failed to request upload URL");
          const { uploadURL, objectPath } = (await meta.json()) as {
            uploadURL: string;
            objectPath: string;
          };
          const put = await fetch(uploadURL, {
            method: "PUT",
            headers: { "Content-Type": file.type },
            body: file,
          });
          if (!put.ok) throw new Error("Upload failed");
          return { kind: "image", url: objectPath, alt: file.name };
        }

        // Non-image files (CSV / PDF / TXT / JSON / etc.) → project-scoped
        // uploads (Task #540). Two-step: request presigned URL, PUT, then
        // register with the project so `list_uploads`/`read_upload` agent
        // tools can see it.
        const reqRes = await fetch(`/api/projects/${projectId}/uploads/request-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            name: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
          }),
        });
        if (!reqRes.ok) {
          const err = (await reqRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Failed to request upload URL");
        }
        const { uploadURL, objectPath } = (await reqRes.json()) as {
          uploadURL: string;
          objectPath: string;
        };
        const put = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error("Upload failed");
        const regRes = await fetch(`/api/projects/${projectId}/uploads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            objectPath,
            name: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
          }),
        });
        if (!regRes.ok) {
          const err = (await regRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Failed to register upload");
        }
        const row = (await regRes.json()) as {
          id: number;
          filename: string;
          mimeType: string;
          sizeBytes: number;
        };
        return {
          kind: "file",
          uploadId: row.id,
          name: row.filename,
          mime: row.mimeType,
          size: row.sizeBytes,
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Upload failed:", err);
        return null;
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    },
    [projectId],
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;
      const results = await Promise.all(arr.map((f) => uploadFile(f)));
      const ok = results.filter((r): r is ComposerAttachment => r !== null);
      if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
    },
    [uploadFile],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files: File[] = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        await handleFiles(files);
      }
    },
    [handleFiles],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleGenerateImage = useCallback(async () => {
    const p = imagePrompt.trim();
    if (!p || generatingImage) return;
    setGeneratingImage(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ prompt: p }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "Image generation failed");
      }
      const data = (await res.json()) as {
        attachment: { kind: "image"; url: string; alt?: string; generated?: boolean };
      };
      setAttachments((prev) => [...prev, data.attachment]);
      setImagePrompt("");
      setImagePanelOpen(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Image generation failed:", err);
    } finally {
      setGeneratingImage(false);
    }
  }, [imagePrompt, generatingImage, projectId]);

  // Client-side intent heuristic — fast local keyword scan for immediate UI feedback.
  // The authoritative routing still happens server-side; this is display-only.
  const clientIntent = useMemo((): "converse" | "plan" | "build" | null => {
    const text = rows[0]?.text?.trim() ?? "";
    if (text.length < 4) return null;
    const lower = text.toLowerCase();
    const questionWords =
      /^(what|how|why|where|when|who|which|can you|could you|do you|is there|explain|tell me|describe|show me|what does|what is|why does|does this)/;
    if (questionWords.test(lower) || lower.endsWith("?")) return "converse";
    const planWords =
      /\b(plan|design|architect|outline|structure|diagram|blueprint|strategy|roadmap|spec|prototype)\b/;
    if (planWords.test(lower)) return "plan";
    const buildWords =
      /\b(add|build|create|make|implement|fix|remove|delete|update|change|refactor|style|integrate|connect|deploy|enable|disable|install|generate|write)\b/;
    if (buildWords.test(lower)) return "build";
    return null;
  }, [rows]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragItemId = useRef<string | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  // ── Voice dictation (Web Speech API) ──────────────────────────────────────
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceSessionIdRef = useRef<number>(0);
  const voiceBaseTextRef = useRef<string>("");
  const voiceTargetRowIdRef = useRef<string | null>(null);
  const mediaRecorderSupported = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia,
    [],
  );
  const voiceSupported = useMemo(
    () => getSpeechRecognitionCtor() !== null || mediaRecorderSupported,
    [mediaRecorderSupported],
  );
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  const stopWhisperRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.stop();
      } catch {
        /* ignore */
      }
    }
    const stream = mediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
  }, []);

  const startWhisperRecording = useCallback(async () => {
    setVoiceError(null);
    const targetRow = rows[0];
    if (!targetRow) return;
    voiceTargetRowIdRef.current = targetRow.id;
    voiceBaseTextRef.current = targetRow.text;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceError(
        "Microphone access blocked. Allow microphone access in your browser to dictate.",
      );
      return;
    }
    mediaStreamRef.current = stream;
    const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaChunksRef.current = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      const blob = new Blob(mediaChunksRef.current, { type: "audio/webm" });
      mediaChunksRef.current = [];
      setIsListening(false);
      if (blob.size === 0) return;
      try {
        const res = await fetch("/api/transcribe?format=webm", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
          credentials: "include",
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          setVoiceError(errBody.error ?? `Transcription failed (HTTP ${res.status})`);
          return;
        }
        const { text } = (await res.json()) as { text?: string };
        if (!text) return;
        const base = voiceBaseTextRef.current;
        const combined = (base ? base + (base.endsWith(" ") ? "" : " ") : "") + text;
        const rowId = voiceTargetRowIdRef.current;
        if (!rowId) return;
        let isSingleRow = false;
        setRows((prev) => {
          isSingleRow = prev.length === 1;
          return prev.map((r) => (r.id === rowId ? { ...r, text: combined } : r));
        });
        if (isSingleRow) {
          if (onPromptValueChange) onPromptValueChange(combined);
          onPromptForRouting(combined);
        }
      } catch (err) {
        setVoiceError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    mediaRecorderRef.current = mr;
    try {
      mr.start();
      setIsListening(true);
    } catch (err) {
      setVoiceError(
        `Could not start microphone: ${err instanceof Error ? err.message : String(err)}`,
      );
      stopWhisperRecording();
    }
  }, [rows, onPromptValueChange, onPromptForRouting, stopWhisperRecording]);

  const isMultiRow = rows.length > 1;

  useEffect(() => {
    if (promptValue !== undefined) {
      setRows((prev) => {
        if (prev.length !== 1) return prev;
        return [{ id: prev[0]!.id, text: promptValue }];
      });
    }
  }, [promptValue]);

  const updateRow = useCallback(
    (id: string, text: string) => {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)));
      if (rows.length === 1 && onPromptValueChange) {
        onPromptValueChange(text);
      }
      if (rows.length === 1) {
        onPromptForRouting(text);
      }
    },
    [rows.length, onPromptValueChange, onPromptForRouting],
  );

  const addRow = useCallback(() => {
    const newId = crypto.randomUUID();
    setRows((prev) => [...prev, { id: newId, text: "" }]);
    setTimeout(() => textareaRefs.current.get(newId)?.focus(), 50);
  }, []);

  const removeRow = useCallback((id: string) => {
    if (voiceTargetRowIdRef.current === id) {
      voiceSessionIdRef.current += 1;
      const rec = recognitionRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try {
          rec.abort();
        } catch {
          // ignore
        }
      }
      recognitionRef.current = null;
      voiceTargetRowIdRef.current = null;
      setIsListening(false);
    }
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const clearQueue = useCallback(() => {
    // Stop any active dictation — the row it was targeting is about to disappear.
    voiceSessionIdRef.current += 1;
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // ignore
      }
    }
    recognitionRef.current = null;
    voiceTargetRowIdRef.current = null;
    setIsListening(false);
    const newId = crypto.randomUUID();
    setRows([{ id: newId, text: "" }]);
    if (onPromptValueChange) onPromptValueChange("");
  }, [onPromptValueChange]);

  const VARIANT_A_SUFFIX =
    "\n\n[VARIANT A — Design direction: clean, minimalist, light palette, generous whitespace, subtle typography]";
  const VARIANT_B_SUFFIX =
    "\n\n[VARIANT B — Design direction: bold, rich, dark palette, vibrant accent colors, eye-catching visuals]";

  const stopVoiceDictation = useCallback(() => {
    // Invalidate any in-flight session so late callbacks are ignored.
    voiceSessionIdRef.current += 1;
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // ignore — already stopped
      }
    }
    recognitionRef.current = null;
    voiceTargetRowIdRef.current = null;
    // Also tear down any MediaRecorder/Whisper fallback session so both
    // voice paths stop in every exit flow (send, clear, remove row, unmount).
    stopWhisperRecording();
    setIsListening(false);
  }, [stopWhisperRecording]);

  const startVoiceDictation = useCallback(() => {
    if (isListening) {
      stopVoiceDictation();
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      // Fallback path: MediaRecorder → /api/transcribe (Whisper).
      if (mediaRecorderSupported) {
        void startWhisperRecording();
        return;
      }
      setVoiceError(
        "Voice input isn't supported in this browser — try Chrome, Edge, or Safari on desktop.",
      );
      return;
    }
    // Tear down any lingering instance before starting a fresh session.
    if (recognitionRef.current) {
      const old = recognitionRef.current;
      old.onresult = null;
      old.onerror = null;
      old.onend = null;
      try {
        old.abort();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    setVoiceError(null);
    const targetRow = rows[0];
    if (!targetRow) return;
    voiceTargetRowIdRef.current = targetRow.id;
    voiceBaseTextRef.current = targetRow.text;
    voiceSessionIdRef.current += 1;
    const sessionId = voiceSessionIdRef.current;

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event) => {
      if (voiceSessionIdRef.current !== sessionId) return; // stale session
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (!r) continue;
        const transcript = r[0]?.transcript ?? "";
        if (r.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      const base = voiceBaseTextRef.current;
      if (finalText) {
        voiceBaseTextRef.current = (base + (base && !base.endsWith(" ") ? " " : "") + finalText)
          .replace(/\s+/g, " ")
          .trimStart();
      }
      const combined =
        voiceBaseTextRef.current +
        (interimText
          ? (voiceBaseTextRef.current && !voiceBaseTextRef.current.endsWith(" ") ? " " : "") +
            interimText
          : "");
      const rowId = voiceTargetRowIdRef.current;
      if (!rowId) return;
      // Conditional write + mirror updateRow's side effects in one pass.
      // If the row no longer exists (sent / cleared / removed), auto-stop.
      let rowStillExists = false;
      let isSingleRow = false;
      setRows((prev) => {
        rowStillExists = prev.some((r) => r.id === rowId);
        isSingleRow = prev.length === 1;
        if (!rowStillExists) return prev;
        return prev.map((r) => (r.id === rowId ? { ...r, text: combined } : r));
      });
      if (!rowStillExists) {
        stopVoiceDictation();
        return;
      }
      if (isSingleRow) {
        if (onPromptValueChange) onPromptValueChange(combined);
        onPromptForRouting(combined);
      }
    };
    rec.onerror = (e) => {
      if (voiceSessionIdRef.current !== sessionId) return;
      const code = e?.error ?? "";
      if (code === "not-allowed" || code === "service-not-allowed") {
        setVoiceError(
          "Microphone access blocked. Allow microphone access in your browser to dictate.",
        );
      } else if (code === "no-speech") {
        setVoiceError(null);
      } else if (code) {
        setVoiceError(`Voice input error: ${code}`);
      }
      setIsListening(false);
    };
    rec.onend = () => {
      if (voiceSessionIdRef.current !== sessionId) return;
      setIsListening(false);
      recognitionRef.current = null;
      voiceTargetRowIdRef.current = null;
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setIsListening(true);
    } catch (err) {
      setVoiceError(
        `Could not start voice input: ${err instanceof Error ? err.message : String(err)}`,
      );
      setIsListening(false);
    }
  }, [
    isListening,
    rows,
    stopVoiceDictation,
    mediaRecorderSupported,
    startWhisperRecording,
    onPromptValueChange,
    onPromptForRouting,
  ]);

  // Cleanup recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  const handleSend = useCallback(async () => {
    const messages = rows.map((r) => r.text.trim()).filter(Boolean);
    if (messages.length === 0) return;
    // Stop voice dictation before sending so late callbacks can't mutate the cleared composer.
    if (isListening || recognitionRef.current) {
      stopVoiceDictation();
    }

    // Variant mode: expand a single prompt into two variant tasks sent as a batch
    if (variantMode && messages.length === 1) {
      const text = messages[0]!;
      const variantMessages = [text + VARIANT_A_SUFFIX, text + VARIANT_B_SUFFIX];
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: variantMessages, agentMode, planMode }),
          credentials: "include",
        });
        if (!res.ok) {
          const err = (await res.json()) as { error?: string };
          throw new Error(err.error ?? "Queue submission failed");
        }
        const data = (await res.json()) as { batchId: string; totalTasks: number };
        setRows([{ id: crypto.randomUUID(), text: "" }]);
        if (onPromptValueChange) onPromptValueChange("");
        onBatchStarted(data.batchId, data.totalTasks);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Variant queue submission failed:", err);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (messages.length === 1) {
      const text = messages[0]!;
      const pending = attachments;
      setRows([{ id: crypto.randomUUID(), text: "" }]);
      setAttachments([]);
      if (onPromptValueChange) onPromptValueChange("");
      // Only inline image attachments go on the message payload. File uploads
      // (CSV/PDF/etc.) live in the project_uploads table and the agent reads
      // them via list_uploads / read_upload tools.
      const inlineImages = pending.filter(
        (a): a is Extract<ComposerAttachment, { kind: "image" }> => a.kind === "image",
      );
      // Pass the client-detected intent so the server skips the classifier
      // and routes directly — prevents the agent from asking the user to
      // "switch to plan mode" when the message is clearly a planning request.
      const detectedIntent =
        clientIntent === "plan" || clientIntent === "converse" ? clientIntent : undefined;
      onSingleSend(text, detectedIntent, inlineImages.length > 0 ? inlineImages : undefined);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, agentMode, planMode }),
        credentials: "include",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? "Queue submission failed");
      }
      const data = (await res.json()) as { batchId: string; totalTasks: number };
      setRows([{ id: crypto.randomUUID(), text: "" }]);
      if (onPromptValueChange) onPromptValueChange("");
      onBatchStarted(data.batchId, data.totalTasks);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Queue submission failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    rows,
    agentMode,
    planMode,
    variantMode,
    projectId,
    clientIntent,
    onSingleSend,
    onBatchStarted,
    onPromptValueChange,
    attachments,
    isListening,
    stopVoiceDictation,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, _rowId: string) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
        return;
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        addRow();
        return;
      }
    },
    [addRow, handleSend],
  );

  const handleDragStart = useCallback((id: string) => {
    dragItemId.current = id;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const fromId = dragItemId.current;
    if (!fromId || fromId === targetId) {
      setDragOverId(null);
      return;
    }
    setRows((prev) => {
      const fromIdx = prev.findIndex((r) => r.id === fromId);
      const toIdx = prev.findIndex((r) => r.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      if (item) next.splice(toIdx, 0, item);
      return next;
    });
    dragItemId.current = null;
    setDragOverId(null);
  }, []);

  const isBusy = disabled || isSubmitting;
  const canSend = rows.some((r) => r.text.trim().length > 0) && !isBusy;
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileDragDepthRef = useRef(0);

  return (
    <div
      className="shrink-0 px-3 py-2.5 border-t border-border relative"
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          fileDragDepthRef.current += 1;
          setFileDragActive(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
          if (fileDragDepthRef.current === 0) setFileDragActive(false);
        }
      }}
      onDrop={(e) => {
        const files = e.dataTransfer?.files;
        fileDragDepthRef.current = 0;
        setFileDragActive(false);
        if (files && files.length > 0) {
          e.preventDefault();
          void handleFiles(files);
        }
      }}
    >
      {fileDragActive && (
        <div className="pointer-events-none absolute inset-2 z-20 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/10 backdrop-blur-[2px] flex items-center justify-center">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-background/80 border border-primary/40 text-primary text-xs font-semibold shadow-md">
            <ImageIcon className="h-3.5 w-3.5" />
            Drop screenshot to build from it
          </div>
        </div>
      )}
      {isMultiRow && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Queue — {rows.length} tasks
          </span>
          <button
            onClick={clearQueue}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-muted-foreground border border-border hover:text-foreground hover:border-destructive/50 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-2.5 w-2.5" />
            Clear queue
          </button>
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center shrink-0 shadow-md shadow-primary/20 mt-0.5">
          <Sparkles style={{ width: 12, height: 12 }} className="text-white" />
        </div>

        <div className="flex-1 bg-muted border border-border rounded-2xl rounded-tl-sm overflow-hidden">
          {rows.map((row, idx) => (
            <div
              key={row.id}
              draggable={isMultiRow}
              onDragStart={() => handleDragStart(row.id)}
              onDragOver={(e) => handleDragOver(e, row.id)}
              onDrop={(e) => handleDrop(e, row.id)}
              onDragEnd={() => setDragOverId(null)}
              className={cn(
                "flex items-start gap-1.5 transition-colors",
                idx > 0 && "border-t border-border/40",
                dragOverId === row.id && "bg-primary/5",
              )}
            >
              {isMultiRow && (
                <div className="flex items-center gap-1 pt-2.5 pl-2 shrink-0">
                  <span className="text-[9px] font-bold text-muted-foreground/50 w-4 text-right">
                    {idx + 1}
                  </span>
                  <GripVertical className="h-3 w-3 text-muted-foreground/30 cursor-grab" />
                </div>
              )}
              <textarea
                ref={(el) => {
                  if (el) textareaRefs.current.set(row.id, el);
                  else textareaRefs.current.delete(row.id);
                }}
                value={row.text}
                onChange={(e) => updateRow(row.id, e.target.value)}
                placeholder={
                  idx === 0
                    ? planMode
                      ? "Describe your app — I'll create a plan first…"
                      : isMultiRow
                        ? "Task 1…"
                        : "Ask anything — I'll answer, plan, or build…"
                    : `Task ${idx + 1}…`
                }
                rows={isMultiRow ? 1 : 2}
                className="flex-1 bg-transparent px-4 pt-2.5 pb-1.5 text-sm resize-none focus:outline-none text-foreground placeholder:text-muted-foreground/60"
                onKeyDown={(e) => handleKeyDown(e, row.id)}
                onPaste={idx === 0 ? handlePaste : undefined}
                title={
                  isMultiRow
                    ? "Shift+Enter to add task · ⌘↩ to send all"
                    : "⌘↩ or Enter to send · Shift+Enter to add task to queue"
                }
              />
              {isMultiRow && (
                <button
                  onClick={() => removeRow(row.id)}
                  className="mt-2 mr-2 w-4 h-4 shrink-0 flex items-center justify-center rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="Remove task"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}

          {isMultiRow && (
            <button
              onClick={addRow}
              className="w-full flex items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors border-t border-border/30"
            >
              <Plus className="h-3 w-3" />
              Add task to queue
            </button>
          )}

          {(isListening || voiceError) && (
            <div
              className={cn(
                "mx-3 mt-1 mb-0.5 flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[10px]",
                isListening
                  ? "bg-red-500/10 text-red-300 border border-red-500/20"
                  : "bg-amber-500/10 text-amber-300 border border-amber-500/20",
              )}
              role="status"
              aria-live="polite"
            >
              <span className="flex items-center gap-1.5">
                {isListening && (
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                )}
                {isListening
                  ? "Listening — speak now. Review and edit the transcript before pressing Send."
                  : voiceError}
              </span>
              {isListening && (
                <button
                  type="button"
                  onClick={stopVoiceDictation}
                  className="text-[10px] font-medium text-red-300 hover:text-red-200 underline underline-offset-2"
                >
                  Stop
                </button>
              )}
              {!isListening && voiceError && (
                <button
                  type="button"
                  onClick={() => setVoiceError(null)}
                  className="text-muted-foreground/70 hover:text-foreground"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {(attachments.length > 0 || uploadingCount > 0) && (
            <div className="px-3 pt-1.5 flex flex-wrap gap-1.5">
              {attachments.map((a, i) => {
                if (a.kind === "image") {
                  const src = a.url.startsWith("/objects/") ? `/api/storage${a.url}` : a.url;
                  return (
                    <div
                      key={`img-${a.url}-${i}`}
                      className="relative group rounded-md overflow-hidden border border-border bg-background/60"
                    >
                      <img
                        src={src}
                        alt={a.alt ?? "attachment"}
                        className="block h-14 w-14 object-cover"
                      />
                      {a.generated && (
                        <span className="absolute bottom-0 left-0 right-0 text-[8px] font-bold text-center bg-primary/80 text-primary-foreground py-0.5 leading-none">
                          AI
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeAttachment(i)}
                        className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center bg-background/80 text-muted-foreground hover:text-destructive rounded-bl-md"
                        title="Remove"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  );
                }
                return (
                  <div
                    key={`file-${a.uploadId}-${i}`}
                    className="relative group rounded-md border border-border bg-background/60 px-2 py-1.5 max-w-[180px]"
                    title={`${a.name} (${a.mime})`}
                  >
                    <div className="flex items-center gap-1.5 pr-4">
                      <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-[10px] text-foreground truncate">{a.name}</span>
                    </div>
                    <div className="text-[9px] text-muted-foreground mt-0.5">
                      {(a.size / 1024).toFixed(1)} KB
                    </div>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center bg-background/80 text-muted-foreground hover:text-destructive rounded-bl-md"
                      title="Remove"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
              {uploadingCount > 0 && (
                <div className="h-14 w-14 flex items-center justify-center rounded-md border border-dashed border-border bg-background/40 text-[9px] text-muted-foreground">
                  Uploading…
                </div>
              )}
            </div>
          )}
          {imagePanelOpen && (
            <div className="px-3 pt-1.5">
              <div className="flex items-center gap-1.5 bg-background/60 border border-border rounded-lg px-2 py-1.5">
                <ImageIcon className="h-3.5 w-3.5 text-secondary shrink-0" />
                <input
                  type="text"
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleGenerateImage();
                    }
                    if (e.key === "Escape") {
                      setImagePanelOpen(false);
                    }
                  }}
                  placeholder="Describe an image to generate…"
                  className="flex-1 bg-transparent text-xs focus:outline-none text-foreground placeholder:text-muted-foreground/60"
                  autoFocus
                />
                <button
                  type="button"
                  disabled={generatingImage || imagePrompt.trim().length === 0}
                  onClick={() => void handleGenerateImage()}
                  className="px-2 py-0.5 text-[10px] font-semibold rounded-md bg-primary text-primary-foreground disabled:opacity-40"
                >
                  {generatingImage ? "Generating…" : "Generate"}
                </button>
                <button
                  type="button"
                  onClick={() => setImagePanelOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Close"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
          <div className="h-px bg-border/40 mx-4 mt-1.5" />
          <div className="flex items-center gap-2 px-3 py-1.5">
            {!isMultiRow && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="*/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) void handleFiles(e.target.files);
                    e.currentTarget.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Attach file (image, CSV, PDF, etc.)"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setImagePanelOpen((v) => !v)}
                  className={cn(
                    "w-6 h-6 flex items-center justify-center rounded-md transition-colors",
                    imagePanelOpen
                      ? "text-secondary bg-secondary/15"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/60",
                  )}
                  title="Generate an image with AI"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Attach design"
                >
                  <Paintbrush2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={startVoiceDictation}
                  disabled={!voiceSupported}
                  className={cn(
                    "w-6 h-6 flex items-center justify-center rounded-md transition-colors",
                    isListening
                      ? "text-red-400 bg-red-500/15 hover:bg-red-500/25 animate-pulse"
                      : "text-muted-foreground hover:text-foreground hover:bg-background/60",
                    !voiceSupported && "opacity-40 cursor-not-allowed",
                  )}
                  title={
                    !voiceSupported
                      ? "Voice input not supported in this browser"
                      : isListening
                        ? "Stop dictation — review the transcript before sending"
                        : "Dictate by voice — transcript appears here so you can edit before sending"
                  }
                  aria-pressed={isListening}
                  aria-label={isListening ? "Stop voice dictation" : "Start voice dictation"}
                >
                  <Mic className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={addRow}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Add task to queue (Shift+Enter)"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex flex-col items-end gap-0.5">
                <div className="flex bg-background/60 border border-border rounded-lg p-0.5">
                  {(
                    [
                      { mode: "lite", label: "Lite", desc: "1 credit · fastest" },
                      { mode: "eco", label: "Eco", desc: "2 credits · fast & lightweight" },
                      { mode: "power", label: "Power", desc: "5 credits · better quality" },
                      { mode: "pro", label: "Pro", desc: "10 credits · most capable" },
                    ] as const
                  ).map(({ mode, label, desc }) => {
                    const locked = false;
                    const title = locked
                      ? `Upgrade to unlock — ${label} mode is included with the Pro and Team plans`
                      : desc;
                    return (
                      <button
                        key={mode}
                        onClick={() => {
                          if (locked) {
                            window.location.href = "/billing";
                            return;
                          }
                          onAgentModeChange(mode);
                        }}
                        title={title}
                        aria-disabled={locked}
                        className={cn(
                          "px-2 py-0.5 text-[9px] uppercase font-bold rounded-md transition-colors inline-flex items-center gap-0.5",
                          agentMode === mode && !locked
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : locked
                              ? "text-muted-foreground/40 hover:text-muted-foreground cursor-help"
                              : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {locked && <Lock style={{ width: 8, height: 8 }} />}
                        {label}
                      </button>
                    );
                  })}
                </div>
                <span className="text-[9px] text-muted-foreground/50 pr-0.5">
                  {agentMode === "lite"
                    ? "1 credit · fastest"
                    : agentMode === "eco"
                      ? "2 credits · fast & lightweight"
                      : agentMode === "power"
                        ? "5 credits · better quality"
                        : "10 credits · most capable"}
                </span>
              </div>
              {activeTaskId != null ? (
                <button
                  onClick={onStopBuild}
                  title="Stop the current build"
                  className="h-8 px-3 bg-destructive/90 rounded-xl flex items-center gap-1.5 shadow-md shadow-destructive/20 hover:bg-destructive transition-colors text-destructive-foreground"
                >
                  <Square style={{ width: 12, height: 12 }} className="fill-current" />
                  <span className="text-[11px] font-semibold">Stop</span>
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  title={isMultiRow ? `Send all ${rows.length} tasks (⌘↩)` : "Send (⌘↩)"}
                  className="h-8 px-3 bg-primary rounded-xl flex items-center gap-1.5 shadow-md shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-primary-foreground"
                >
                  <Send style={{ width: 14, height: 14 }} />
                  {isMultiRow && <span className="text-[10px] font-bold">{rows.length}</span>}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isBusy && (
        <div className="mt-1.5 px-9 flex items-center gap-2 flex-wrap">
          {/* Three-way agent selector */}
          <div className="flex items-center gap-1 bg-background/60 border border-border rounded-lg p-0.5">
            {AGENT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const isActive = agentType === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setAgentType(opt.value)}
                  title={opt.description}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors border",
                    isActive
                      ? opt.className
                      : "text-muted-foreground border-transparent hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* Client-side intent hint badge — display-only, updates instantly as user types */}
          {clientIntent && !planMode && (
            <span
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border pointer-events-none select-none",
                clientIntent === "converse"
                  ? "border-blue-500/30 bg-blue-500/8 text-blue-400"
                  : clientIntent === "plan"
                    ? "border-secondary/30 bg-secondary/8 text-secondary"
                    : "border-green-500/30 bg-green-500/8 text-green-400",
              )}
            >
              {clientIntent === "converse"
                ? "I'll answer this"
                : clientIntent === "plan"
                  ? "I'll plan this"
                  : "I'll build this"}
            </span>
          )}

          {/* Routing hint badge — updates as user types.
              "planning" is suppressed here because plan intent is auto-detected
              and applied on send — no manual switch required. */}
          {routingHint?.agentIdentity &&
            routingHint.agentIdentity !== agentType &&
            routingHint.agentIdentity !== "planning" && (
              <button
                onClick={() => setAgentType(routingHint.agentIdentity as AgentType)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
                title={routingHint.reason ?? ""}
              >
                Switch to {routingHint.agentIdentity === "task" ? "Task" : "Main"} Agent
              </button>
            )}

          <button
            onClick={() => onVariantModeChange(!variantMode)}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors border",
              variantMode
                ? "bg-violet-500/15 text-violet-400 border-violet-500/30"
                : "text-muted-foreground border-border hover:text-foreground",
            )}
            title="Generate 2 design variants (A: minimalist, B: bold) and pick the best"
          >
            <Layers2 className="h-3 w-3" /> 2 Variants
          </button>

          {/* Template picker + plan history — shown in Planning mode */}
          {agentType === "planning" && (
            <>
              <button
                onClick={() => setShowTemplatePicker(true)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors border text-muted-foreground border-border hover:text-foreground"
                title="Start from a pre-built plan template"
              >
                <LayoutTemplate className="h-3 w-3" /> Templates
              </button>
              <button
                onClick={() => setShowPlanHistory(true)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors border text-muted-foreground border-border hover:text-foreground"
                title="View and restore previous plan versions"
              >
                <Clock className="h-3 w-3" /> Plan history
              </button>
            </>
          )}

          {!isMultiRow && (
            <span className="ml-auto text-[9px] text-muted-foreground/40">
              ⌘↩ send · Shift+↩ add task
            </span>
          )}
        </div>
      )}

      {/* Template picker modal */}
      {showTemplatePicker && (
        <PlanTemplatesPicker
          projectId={projectId}
          onSelect={(plan: StructuredPlan, name: string) => {
            // Inject template plan into the composer as a pre-built prompt
            const templatePrompt = `Apply this plan template "${name}" to build the app:\n\nGoal: ${plan.goal ?? ""}\n${plan.approach ? `Approach: ${plan.approach}\n` : ""}${(plan.sitemap ?? []).length > 0 ? `Pages: ${(plan.sitemap ?? []).map((p) => `${p.name} (${p.route})`).join(", ")}\n` : ""}${(plan.integrations ?? []).length > 0 ? `Integrations: ${plan.integrations!.join(", ")}\n` : ""}`;
            setRows([{ id: crypto.randomUUID(), text: templatePrompt }]);
          }}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}

      {/* Plan history modal */}
      {showPlanHistory && (
        <PlanHistoryPanel
          projectId={projectId}
          onRestorePlan={(plan: StructuredPlan) => {
            const restoredPrompt = `Restore this plan and rebuild the app:\n\nGoal: ${plan.goal ?? ""}\n${plan.approach ? `Approach: ${plan.approach}\n` : ""}${(plan.sitemap ?? []).length > 0 ? `Pages: ${(plan.sitemap ?? []).map((p) => `${p.name} (${p.route})`).join(", ")}\n` : ""}`;
            setRows([{ id: crypto.randomUUID(), text: restoredPrompt }]);
          }}
          onClose={() => setShowPlanHistory(false)}
        />
      )}
    </div>
  );
}
