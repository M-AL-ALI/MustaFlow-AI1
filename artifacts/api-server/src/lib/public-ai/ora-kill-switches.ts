/**
 * Ora Feature Kill Switches — Wave 2A
 *
 * Instant disable switches for each Ora public-AI feature. Env vars are read
 * on every call (not cached at startup) so they can be toggled without a
 * server restart.
 *
 * Usage in a route handler:
 *   if (isKillSwitchActive("file_upload")) {
 *     req.resume();
 *     res.status(503).json(killSwitchBody("file_upload"));
 *     return;
 *   }
 *
 * Kill switch env vars:
 *   ORA_DISABLED=true               — disables all Ora public AI
 *   ORA_STREAMING_DISABLED=true     — disables /chat/stream SSE endpoint
 *   ORA_FILE_UPLOAD_DISABLED=true   — disables /upload (files + images)
 *   ORA_FILE_ANALYSIS_DISABLED=true
 *   ORA_DATASET_ANALYSIS_DISABLED=true
 *   ORA_IMAGE_ANALYSIS_DISABLED=true
 *   ORA_IMAGE_GENERATION_DISABLED=true
 *   ORA_FILE_GENERATION_DISABLED=true
 *   ORA_TTS_DISABLED=true
 *   ORA_TRANSCRIBE_DISABLED=true
 *   ORA_WEB_SEARCH_DISABLED=true
 *   ORA_REALTIME_DISABLED=true     — disables /realtime/session (Talk to Ora live voice)
 */

export type OraFeature =
  | "all"
  | "streaming"
  | "file_upload"
  | "file_analysis"
  | "dataset_analysis"
  | "image_analysis"
  | "image_generation"
  | "file_generation"
  | "tts"
  | "transcribe"
  | "web_search"
  | "realtime";

const FEATURE_ENV_VAR: Record<OraFeature, string> = {
  all: "ORA_DISABLED",
  streaming: "ORA_STREAMING_DISABLED",
  file_upload: "ORA_FILE_UPLOAD_DISABLED",
  file_analysis: "ORA_FILE_ANALYSIS_DISABLED",
  dataset_analysis: "ORA_DATASET_ANALYSIS_DISABLED",
  image_analysis: "ORA_IMAGE_ANALYSIS_DISABLED",
  image_generation: "ORA_IMAGE_GENERATION_DISABLED",
  file_generation: "ORA_FILE_GENERATION_DISABLED",
  tts: "ORA_TTS_DISABLED",
  transcribe: "ORA_TRANSCRIBE_DISABLED",
  web_search: "ORA_WEB_SEARCH_DISABLED",
  realtime: "ORA_REALTIME_DISABLED",
};

const FEATURE_LABEL: Record<OraFeature, string> = {
  all: "Ora",
  streaming: "Ora streaming",
  file_upload: "File upload",
  file_analysis: "File analysis",
  dataset_analysis: "Dataset analysis",
  image_analysis: "Image analysis",
  image_generation: "Image generation",
  file_generation: "File generation",
  tts: "Voice responses",
  transcribe: "Voice input",
  web_search: "Web search",
  realtime: "Talk to Ora",
};

/**
 * Returns true if the given feature is currently disabled via env vars.
 * The global ORA_DISABLED switch blocks every feature, including "all".
 */
export function isKillSwitchActive(feature: OraFeature): boolean {
  if (process.env.ORA_DISABLED === "true") return true;
  return process.env[FEATURE_ENV_VAR[feature]] === "true";
}

/**
 * Structured 503 body for a disabled feature.
 * Always includes `disabled: true` and `feature` so clients can distinguish
 * a kill-switch block from a transient error and display appropriate UI.
 * The error string is intentionally user-friendly — no provider info,
 * no stack traces, no internal identifiers.
 */
export function killSwitchBody(feature: OraFeature): {
  error: string;
  disabled: true;
  feature: OraFeature;
} {
  return {
    error: `${FEATURE_LABEL[feature]} is temporarily unavailable. Please try again later.`,
    disabled: true,
    feature,
  };
}
