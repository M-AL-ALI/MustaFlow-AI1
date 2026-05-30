import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  Rocket,
  Plus,
  X,
  GripVertical,
  Trash2,
  Sparkles,
  Paperclip,
  Mic,
  MicOff,
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
  Bug,
  Wrench,
  CheckSquare,
  BookOpen as BookOpenIcon,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useGetAgentRouting,
  useUpdateProject,
  useUpdateMyPreferences,
} from "@workspace/api-client-react";
import { getVoiceLang, setVoiceLang, VOICE_LANGUAGES } from "@/hooks/use-voice-input";
import { PlanTemplatesPicker } from "./plan-templates-picker";
import { PlanHistoryPanel } from "./plan-history";
import type { StructuredPlan } from "./plan-card";
import { BrainstormPanel } from "@/components/brainstorm-panel";

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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB hard limit per file
const MAX_IMAGE_SIDE = 1500; // px — downscale if either dimension exceeds this
const MAX_IMAGE_BYTES_BEFORE_RESIZE = 1 * 1024 * 1024; // 1 MB — also resize even if dimensions ok
const MAX_IMAGES_PER_MESSAGE = 4; // max simultaneous image attachments

/**
 * Downscale an image File using a hidden canvas element if it exceeds the
 * MAX_IMAGE_SIDE or MAX_IMAGE_BYTES_BEFORE_RESIZE thresholds.  Returns the
 * original File unchanged when no resizing is needed.
 */
async function resizeImageForVision(file: File): Promise<Blob> {
  // Fast path: small image that fits within both limits — no canvas needed.
  if (file.size <= MAX_IMAGE_BYTES_BEFORE_RESIZE) {
    try {
      const bitmap = await createImageBitmap(file);
      const fits = bitmap.width <= MAX_IMAGE_SIDE && bitmap.height <= MAX_IMAGE_SIDE;
      bitmap.close();
      if (fits) return file;
    } catch {
      // createImageBitmap unsupported — fall through to canvas path
    }
  }

  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(MAX_IMAGE_SIDE / img.width, MAX_IMAGE_SIDE / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Canvas toBlob returned null"));
            return;
          }
          resolve(blob);
        },
        "image/jpeg",
        0.85,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load image for resizing"));
    };
    img.src = objectUrl;
  });
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
    agentIntent?: "converse" | "plan" | "build" | "debug" | "refactor" | "review" | "explain",
    attachments?: ComposerAttachment[],
    brainstormContext?: Array<{ role: "user" | "assistant"; content: string }>,
  ) => void;
  onBatchStarted: (batchId: string, totalCount: number) => void;
  promptValue?: string;
  onPromptValueChange?: (v: string) => void;
  onAgentIdentityChange?: (identity: AgentType) => void;
  chatPlaceholder?: string;
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
  chatPlaceholder,
}: QueueComposerProps) {
  const lsKey = `mustaflow_agent_type_${projectId}`;
  const [agentType, setAgentTypeRaw] = useState<AgentType>(() => {
    const stored = localStorage.getItem(lsKey);
    return (stored as AgentType | null) ?? "main";
  });

  // ── Persistent developer intent ────────────────────────────────────────────
  type DeveloperIntent = "debug" | "refactor" | "review" | "explain";
  const intentLsKey = `mustaflow_active_intent_${projectId}`;
  const [activeIntent, setActiveIntentRaw] = useState<DeveloperIntent | null>(() => {
    try {
      const stored = localStorage.getItem(intentLsKey);
      if (
        stored === "debug" ||
        stored === "refactor" ||
        stored === "review" ||
        stored === "explain"
      ) {
        return stored as DeveloperIntent;
      }
      return null;
    } catch {
      return null;
    }
  });
  const setActiveIntent = useCallback(
    (intent: DeveloperIntent | null) => {
      setActiveIntentRaw(intent);
      try {
        if (intent) {
          localStorage.setItem(intentLsKey, intent);
        } else {
          localStorage.removeItem(intentLsKey);
        }
      } catch {
        /* ignore */
      }
    },
    [intentLsKey],
  );

  const { mutate: updateProject } = useUpdateProject();
  const { mutate: updateMyPreferences } = useUpdateMyPreferences();

  // ── Voice language picker ────────────────────────────────────────────────
  const [currentVoiceLang, setCurrentVoiceLang] = useState<string>(() => {
    if (typeof window === "undefined") return "auto";
    return localStorage.getItem("mustaflow_voice_lang") ?? "auto";
  });

  const handleVoiceLangChange = useCallback(
    (lang: string) => {
      setCurrentVoiceLang(lang);
      // Write localStorage immediately so it's available even when offline
      if (lang === "auto") {
        localStorage.removeItem("mustaflow_voice_lang");
      } else {
        setVoiceLang(lang);
      }
      // Best-effort server sync — silently no-ops when offline
      try {
        updateMyPreferences({ data: { voiceLang: lang === "auto" ? null : lang } });
      } catch {
        // offline — localStorage write above is the durable fallback
      }
    },
    [updateMyPreferences],
  );

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
  const [attachErrors, setAttachErrors] = useState<string[]>([]);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imagePanelOpen, setImagePanelOpen] = useState(false);
  const [generatingImage, setGeneratingImage] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showPlanHistory, setShowPlanHistory] = useState(false);
  const [showBrainstorm, setShowBrainstorm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const brainstormContextRef = useRef<Array<{
    role: "user" | "assistant";
    content: string;
  }> | null>(null);

  const uploadFile = useCallback(
    async (file: File): Promise<{ attachment: ComposerAttachment | null; error?: string }> => {
      // Image path — screenshot-to-code flow with client-side resizing.
      if (file.type.startsWith("image/")) {
        // Validate MIME type (PNG / JPG / WebP only)
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          return {
            attachment: null,
            error: `"${file.name}": only PNG, JPG, and WebP images are supported.`,
          };
        }
        // Validate raw size before resizing (5 MB cap on original)
        if (file.size > MAX_IMAGE_BYTES) {
          return {
            attachment: null,
            error: `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB per image.`,
          };
        }
        setUploadingCount((c) => c + 1);
        try {
          // Downscale to ≤ 1500 px on either side if needed.
          const blob = await resizeImageForVision(file);
          const contentType = blob.type || file.type;

          // Get a signed PUT URL from the project-scoped endpoint.
          const meta = await fetch(`/api/projects/${projectId}/attachments/upload-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ contentType, sizeBytes: blob.size }),
          });
          if (!meta.ok) {
            const err = (await meta.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? "Failed to request upload URL");
          }
          const { uploadUrl, objectPath } = (await meta.json()) as {
            uploadUrl: string;
            objectPath: string;
          };

          // PUT the (possibly resized) blob directly to the signed URL.
          const put = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": contentType },
            body: blob,
          });
          if (!put.ok) throw new Error("Image upload failed");

          return { attachment: { kind: "image", url: objectPath, alt: file.name } };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("Image upload failed:", err);
          return {
            attachment: null,
            error: err instanceof Error ? err.message : "Image upload failed",
          };
        } finally {
          setUploadingCount((c) => Math.max(0, c - 1));
        }
      }

      setUploadingCount((c) => c + 1);
      try {
        // ── Non-image files handled below (original flow kept intact) ──────

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
            sizeBytes: file.size,
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
          attachment: {
            kind: "file",
            uploadId: row.id,
            name: row.filename,
            mime: row.mimeType,
            size: row.sizeBytes,
          },
        };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Upload failed:", err);
        return { attachment: null };
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

      const newErrors: string[] = [];

      // Separate images from other files so we can enforce the per-message image cap.
      const imageFiles = arr.filter((f) => f.type.startsWith("image/"));
      const otherFiles = arr.filter((f) => !f.type.startsWith("image/"));

      // Determine how many image slots are still available.
      // Include in-flight uploads (uploadingCount) to avoid overrun during concurrent attaches.
      const currentImageCount =
        attachments.filter((a) => a.kind === "image").length + uploadingCount;
      const remainingSlots = Math.max(0, MAX_IMAGES_PER_MESSAGE - currentImageCount);

      // Images that exceed the per-message cap are rejected immediately.
      const imagesToProcess = imageFiles.slice(0, remainingSlots);
      const rejectedImages = imageFiles.slice(remainingSlots);
      for (const f of rejectedImages) {
        newErrors.push(
          `"${f.name}" skipped — maximum of ${MAX_IMAGES_PER_MESSAGE} images per message.`,
        );
      }

      const filesToProcess = [...imagesToProcess, ...otherFiles];
      if (filesToProcess.length === 0) {
        if (newErrors.length > 0) setAttachErrors(newErrors);
        return;
      }

      const results = await Promise.all(filesToProcess.map((f) => uploadFile(f)));
      const ok: ComposerAttachment[] = [];
      for (const r of results) {
        if (r.attachment) ok.push(r.attachment);
        if (r.error) newErrors.push(r.error);
      }

      if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
      // Always update errors (even if empty) so stale errors from a previous
      // attempt are cleared when a subsequent attach succeeds.
      setAttachErrors(newErrors);
    },
    [uploadFile, attachments, uploadingCount],
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
    // Enforce per-message image cap before starting the network request.
    const currentImageCount = attachments.filter((a) => a.kind === "image").length + uploadingCount;
    if (currentImageCount >= MAX_IMAGES_PER_MESSAGE) {
      setAttachErrors([
        `Maximum of ${MAX_IMAGES_PER_MESSAGE} images per message — remove one before generating another.`,
      ]);
      return;
    }
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
      setAttachErrors([]);
      setImagePrompt("");
      setImagePanelOpen(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Image generation failed:", err);
    } finally {
      setGeneratingImage(false);
    }
  }, [imagePrompt, generatingImage, projectId, attachments, uploadingCount]);

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
  // Whether we *intend* to be listening — survives browser-side session drops.
  const shouldListenRef = useRef(false);

  // ── Waveform (AnalyserNode) ────────────────────────────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const analysisStreamRef = useRef<MediaStream | null>(null);
  const [waveformBars, setWaveformBars] = useState<number[]>([0.15, 0.15, 0.15, 0.15, 0.15]);

  const stopAudioAnalysis = useCallback(() => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        /* ignore */
      }
      analyserRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        void audioContextRef.current.close();
      } catch {
        /* ignore */
      }
      audioContextRef.current = null;
    }
    if (analysisStreamRef.current) {
      analysisStreamRef.current.getTracks().forEach((t) => t.stop());
      analysisStreamRef.current = null;
    }
    setWaveformBars([0.15, 0.15, 0.15, 0.15, 0.15]);
  }, []);

  const startAudioAnalysis = useCallback(
    (stream: MediaStream) => {
      // Tear down any previous analysis session first.
      stopAudioAnalysis();
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.6;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const NUM_BARS = 5;
        const tick = () => {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(data);
          const binCount = data.length;
          const bars: number[] = [];
          for (let i = 0; i < NUM_BARS; i++) {
            const start = Math.floor((i / NUM_BARS) * binCount);
            const end = Math.floor(((i + 1) / NUM_BARS) * binCount);
            let sum = 0;
            for (let j = start; j < end; j++) sum += data[j] ?? 0;
            const avg = sum / Math.max(1, end - start);
            bars.push(Math.max(0.08, avg / 255));
          }
          setWaveformBars(bars);
          animFrameRef.current = requestAnimationFrame(tick);
        };
        animFrameRef.current = requestAnimationFrame(tick);
      } catch {
        /* Analysis is non-critical — silently skip if AudioContext is unavailable. */
      }
    },
    [stopAudioAnalysis],
  );

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
    stopAudioAnalysis();
  }, [stopAudioAnalysis]);

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
    startAudioAnalysis(stream);
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
  }, [rows, onPromptValueChange, onPromptForRouting, stopWhisperRecording, startAudioAnalysis]);

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

  const removeRow = useCallback(
    (id: string) => {
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
        stopAudioAnalysis();
        setIsListening(false);
      }
      setRows((prev) => {
        if (prev.length <= 1) return prev;
        return prev.filter((r) => r.id !== id);
      });
    },
    [stopAudioAnalysis],
  );

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
    stopAudioAnalysis();
    setIsListening(false);
    const newId = crypto.randomUUID();
    setRows([{ id: newId, text: "" }]);
    setAttachErrors([]);
    if (onPromptValueChange) onPromptValueChange("");
  }, [onPromptValueChange, stopAudioAnalysis]);

  const VARIANT_A_SUFFIX =
    "\n\n[VARIANT A — Design direction: clean, minimalist, light palette, generous whitespace, subtle typography]";
  const VARIANT_B_SUFFIX =
    "\n\n[VARIANT B — Design direction: bold, rich, dark palette, vibrant accent colors, eye-catching visuals]";

  const stopVoiceDictation = useCallback(() => {
    // Mark that we no longer want to be listening so auto-restart in onend
    // knows not to restart the session.
    shouldListenRef.current = false;
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
    shouldListenRef.current = true;
    setIsListening(true);

    // Start waveform analysis: request a separate mic stream for the AnalyserNode
    // (SpeechRecognition doesn't expose its underlying stream).
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        // Guard: if the user stopped dictation while the permission prompt was
        // open (or before the promise resolved), immediately release the stream
        // and bail — do not start analysis after stop.
        if (!shouldListenRef.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        // Set ref AFTER startAudioAnalysis so the stopAudioAnalysis() call
        // inside it doesn't immediately stop the newly-acquired stream.
        startAudioAnalysis(s);
        analysisStreamRef.current = s;
      })
      .catch(() => {
        /* Non-critical — waveform just stays flat if this fails */
      });

    // Creates and starts a fresh recognition instance.  Called on first start
    // and on every auto-restart after the browser ends the continuous session
    // (common on Chrome/Edge after a pause in speech).
    const launchRecognition = () => {
      if (!shouldListenRef.current) return;
      voiceSessionIdRef.current += 1;
      const sessionId = voiceSessionIdRef.current;

      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = getVoiceLang();
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
          // Hard permission error — stop permanently.
          shouldListenRef.current = false;
          stopAudioAnalysis();
          setVoiceError(
            "Microphone access blocked. Allow microphone access in your browser to dictate.",
          );
          setIsListening(false);
        } else if (code === "no-speech") {
          // Silence timeout — onerror is followed by onend which will restart.
          setVoiceError(null);
        } else if (code) {
          // Unknown hard error — stop permanently.
          shouldListenRef.current = false;
          stopAudioAnalysis();
          setVoiceError(`Voice input error: ${code}`);
          setIsListening(false);
        }
      };
      rec.onend = () => {
        if (voiceSessionIdRef.current !== sessionId) return;
        recognitionRef.current = null;
        if (!shouldListenRef.current) {
          // Intentional stop — clean up.
          voiceTargetRowIdRef.current = null;
          stopAudioAnalysis();
          setIsListening(false);
          return;
        }
        // Browser dropped the continuous session (common after silence on
        // Chrome/Edge).  Restart seamlessly so the user never has to re-click.
        launchRecognition();
      };
      recognitionRef.current = rec;
      try {
        rec.start();
      } catch (err) {
        shouldListenRef.current = false;
        stopAudioAnalysis();
        setVoiceError(
          `Could not start voice input: ${err instanceof Error ? err.message : String(err)}`,
        );
        setIsListening(false);
      }
    };

    launchRecognition();
  }, [
    isListening,
    rows,
    stopVoiceDictation,
    mediaRecorderSupported,
    startWhisperRecording,
    onPromptValueChange,
    onPromptForRouting,
    startAudioAnalysis,
    stopAudioAnalysis,
  ]);

  // Cleanup recognition and audio analysis on unmount
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
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (analyserRef.current) {
        try {
          analyserRef.current.disconnect();
        } catch {
          // ignore
        }
        analyserRef.current = null;
      }
      if (audioContextRef.current) {
        try {
          void audioContextRef.current.close();
        } catch {
          // ignore
        }
        audioContextRef.current = null;
      }
      if (analysisStreamRef.current) {
        analysisStreamRef.current.getTracks().forEach((t) => t.stop());
        analysisStreamRef.current = null;
      }
    };
  }, []);

  const handleSend = useCallback(async () => {
    const messages = rows.map((r) => r.text.trim()).filter(Boolean);
    // Allow image-only sends (no text required when a screenshot is attached).
    const hasImageAttachment = attachments.some((a) => a.kind === "image");
    if (messages.length === 0 && !hasImageAttachment) return;
    // Stop voice dictation before sending so late callbacks can't mutate the cleared composer.
    if (isListening || recognitionRef.current) {
      stopVoiceDictation();
    }

    // Variant mode: expand a single prompt into two variant tasks sent as a batch
    if (variantMode && messages.length === 1) {
      const text = messages[0]!;
      const variantMessages = [text + VARIANT_A_SUFFIX, text + VARIANT_B_SUFFIX];
      // Clear brainstorm context — it doesn't apply to batch/variant paths
      brainstormContextRef.current = null;
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: variantMessages,
            agentMode,
            planMode,
            agentIdentity: agentType,
          }),
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

    if (messages.length <= 1 && (messages.length === 1 || hasImageAttachment)) {
      // Image-only send: text is empty string; server injects the default screenshot prompt.
      const text = messages[0] ?? "";
      const pending = attachments;
      setRows([{ id: crypto.randomUUID(), text: "" }]);
      setAttachments([]);
      setAttachErrors([]);
      if (onPromptValueChange) onPromptValueChange("");
      // Only inline image attachments go on the message payload. File uploads
      // (CSV/PDF/etc.) live in the project_uploads table and the agent reads
      // them via list_uploads / read_upload tools.
      const inlineImages = pending.filter(
        (a): a is Extract<ComposerAttachment, { kind: "image" }> => a.kind === "image",
      );
      // Pass the active developer intent (persisted badge) first; fall back to
      // client-detected intent so the server skips the classifier when possible.
      const detectedIntent: Parameters<typeof onSingleSend>[1] = activeIntent
        ? activeIntent
        : clientIntent === "plan" || clientIntent === "converse"
          ? clientIntent
          : undefined;
      const brainstormCtx = brainstormContextRef.current ?? undefined;
      brainstormContextRef.current = null;
      onSingleSend(
        text,
        detectedIntent,
        inlineImages.length > 0 ? inlineImages : undefined,
        brainstormCtx,
      );
      return;
    }

    // Multi-message batch path — brainstorm context doesn't apply here
    brainstormContextRef.current = null;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, agentMode, planMode, agentIdentity: agentType }),
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
    agentType,
    projectId,
    clientIntent,
    activeIntent,
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
  const hasImageAttached = attachments.some((a) => a.kind === "image");
  const canSend = (rows.some((r) => r.text.trim().length > 0) || hasImageAttached) && !isBusy;
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
            Drop images to attach (up to {MAX_IMAGES_PER_MESSAGE})
          </div>
        </div>
      )}

      {/* Brainstorm panel — expands above the composer rows when open */}
      {showBrainstorm && (
        <BrainstormPanel
          onClose={() => setShowBrainstorm(false)}
          projectId={projectId}
          onResolved={(prompt, messages) => {
            setRows([{ id: crypto.randomUUID(), text: prompt }]);
            if (onPromptValueChange) onPromptValueChange(prompt);
            brainstormContextRef.current = messages;
          }}
        />
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
                        : (chatPlaceholder ?? "Ask anything — I'll answer, plan, or build…")
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

          {attachErrors.length > 0 && (
            <div
              className="mx-3 mt-1 mb-0.5 rounded-md px-2 py-1 text-[10px] bg-destructive/10 text-destructive border border-destructive/20"
              role="alert"
            >
              <div className="flex items-start justify-between gap-2">
                <ul className="flex-1 space-y-0.5">
                  {attachErrors.map((err, i) => (
                    <li key={i} className="leading-snug">
                      {err}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => setAttachErrors([])}
                  className="shrink-0 text-destructive/70 hover:text-destructive mt-0.5"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
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
                  <span
                    className="flex items-end gap-px shrink-0"
                    style={{ height: "12px" }}
                    aria-hidden="true"
                  >
                    {waveformBars.map((h, i) => (
                      <span
                        key={i}
                        className="w-[2px] rounded-full bg-red-400"
                        style={{
                          height: `${Math.round(Math.max(0.08, h) * 12)}px`,
                          transition: "height 80ms ease-out",
                        }}
                      />
                    ))}
                  </span>
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
            <div className="px-3 pt-1.5 flex flex-wrap gap-1.5 items-start">
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
              {(() => {
                const imgCount =
                  attachments.filter((a) => a.kind === "image").length + uploadingCount;
                if (imgCount === 0) return null;
                return (
                  <span className="self-end mb-0.5 text-[9px] text-muted-foreground/50 leading-none">
                    {imgCount}/{MAX_IMAGES_PER_MESSAGE} images
                  </span>
                );
              })()}
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
          {activeIntent && (
            <div className="flex items-center gap-1.5 px-3 pt-1 pb-0.5">
              <span className="text-[10px] text-muted-foreground/60">Mode:</span>
              <span
                className={cn(
                  "flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold border",
                  activeIntent === "debug"
                    ? "border-red-500/30 bg-red-500/10 text-red-400"
                    : activeIntent === "refactor"
                      ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                      : activeIntent === "review"
                        ? "border-blue-500/30 bg-blue-500/10 text-blue-400"
                        : "border-violet-500/30 bg-violet-500/10 text-violet-400",
                )}
              >
                {activeIntent === "debug" ? (
                  <Bug className="h-2.5 w-2.5" />
                ) : activeIntent === "refactor" ? (
                  <Wrench className="h-2.5 w-2.5" />
                ) : activeIntent === "review" ? (
                  <CheckSquare className="h-2.5 w-2.5" />
                ) : (
                  <BookOpenIcon className="h-2.5 w-2.5" />
                )}
                {activeIntent.charAt(0).toUpperCase() + activeIntent.slice(1)}
                <button
                  type="button"
                  onClick={() => setActiveIntent(null)}
                  className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                  aria-label="Clear intent"
                  title="Reset to auto-detect"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
              <span className="text-[9px] text-muted-foreground/40">
                Active for all messages — click × to reset
              </span>
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
                  {isListening ? (
                    <MicOff className="h-3.5 w-3.5" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                </button>
                {voiceSupported && (
                  <select
                    value={currentVoiceLang}
                    onChange={(e) => handleVoiceLangChange(e.target.value)}
                    title="Voice input language"
                    aria-label="Voice input language"
                    className={cn(
                      "h-6 rounded-md border border-border bg-background/60 px-1 text-[10px] text-muted-foreground",
                      "hover:text-foreground hover:bg-background transition-colors cursor-pointer",
                      "focus:outline-none focus:ring-1 focus:ring-ring",
                      isListening && "text-red-300 border-red-500/30",
                    )}
                    style={{ maxWidth: "4.5rem" }}
                  >
                    {VOICE_LANGUAGES.map(({ code }) => (
                      <option key={code} value={code}>
                        {code === "auto" ? "Auto" : code}
                      </option>
                    ))}
                  </select>
                )}
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
                {/* Discuss / Brainstorm pill — opens the full BrainstormPanel */}
                <button
                  type="button"
                  onClick={() => setShowBrainstorm((v) => !v)}
                  title={
                    showBrainstorm
                      ? "Close brainstorm panel"
                      : "Brainstorm your idea before building — guided ideation"
                  }
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors shrink-0",
                    showBrainstorm
                      ? "border-violet-500/40 bg-violet-500/20 text-violet-200 hover:bg-violet-500/25"
                      : "border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20",
                  )}
                >
                  {showBrainstorm ? (
                    <X className="h-3.5 w-3.5" />
                  ) : (
                    <Lightbulb className="h-3.5 w-3.5" />
                  )}
                  {showBrainstorm ? "Close brainstorm" : "Brainstorm first"}
                </button>
                <div className="flex bg-background/60 border border-border rounded-lg p-0.5">
                  {(
                    [
                      {
                        mode: "lite",
                        label: "Lite",
                        desc: "1 credit · minimal correct change",
                      },
                      { mode: "eco", label: "Eco", desc: "2 credits · clean typed code" },
                      {
                        mode: "power",
                        label: "Power",
                        desc: "5 credits · production-ready TypeScript",
                      },
                      {
                        mode: "pro",
                        label: "Pro",
                        desc: "10 credits · security-first strict mode",
                      },
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
                    ? "1 credit · minimal correct change"
                    : agentMode === "eco"
                      ? "2 credits · clean typed code"
                      : agentMode === "power"
                        ? "5 credits · production-ready TypeScript"
                        : "10 credits · security-first strict mode"}
                </span>
              </div>
              {activeTaskId != null || (disabled && !isSubmitting) ? (
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
                  <Rocket style={{ width: 14, height: 14 }} />
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

          {/* Developer intent quick-action buttons */}
          {[
            {
              intent: "debug" as const,
              icon: Bug,
              label: "Debug",
              starter: "Debug this error: ",
              title:
                "Paste a stack trace or error message and get a root-cause analysis · 1 credit",
              cls: "border-red-500/20 text-red-400/70 hover:text-red-400 hover:border-red-500/40",
              activeCls: "border-red-500/40 text-red-400 bg-red-500/10",
            },
            {
              intent: "refactor" as const,
              icon: Wrench,
              label: "Refactor",
              starter: "Refactor ",
              title: "Improve code structure without changing behaviour · 1 credit",
              cls: "border-yellow-500/20 text-yellow-400/70 hover:text-yellow-400 hover:border-yellow-500/40",
              activeCls: "border-yellow-500/40 text-yellow-400 bg-yellow-500/10",
            },
            {
              intent: "review" as const,
              icon: CheckSquare,
              label: "Review",
              starter: "Review my code for ",
              title: "Get a structured code review — Critical / Warnings / Suggestions · 1 credit",
              cls: "border-blue-500/20 text-blue-400/70 hover:text-blue-400 hover:border-blue-500/40",
              activeCls: "border-blue-500/40 text-blue-400 bg-blue-500/10",
            },
            {
              intent: "explain" as const,
              icon: BookOpenIcon,
              label: "Explain",
              starter: "Explain how ",
              title: "Get a deep technical explanation with architectural context · 1 credit",
              cls: "border-violet-500/20 text-violet-400/70 hover:text-violet-400 hover:border-violet-500/40",
              activeCls: "border-violet-500/40 text-violet-400 bg-violet-500/10",
            },
          ].map(({ intent, icon: Icon, label, starter, title, cls, activeCls }) => {
            const isActive = activeIntent === intent;
            return (
              <button
                key={intent}
                title={isActive ? `${label} mode is active — click to deactivate` : title}
                onClick={() => {
                  if (isActive) {
                    setActiveIntent(null);
                    return;
                  }
                  // Set the intent mode and prefill the textarea with the starter text
                  setActiveIntent(intent);
                  const newId = crypto.randomUUID();
                  setRows([{ id: newId, text: starter }]);
                  if (onPromptValueChange) onPromptValueChange(starter);
                  setTimeout(() => {
                    const ta = textareaRefs.current.get(newId);
                    if (ta) {
                      ta.focus();
                      ta.setSelectionRange(ta.value.length, ta.value.length);
                    }
                  }, 50);
                }}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors border bg-transparent",
                  isActive ? activeCls : cls,
                )}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            );
          })}

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
