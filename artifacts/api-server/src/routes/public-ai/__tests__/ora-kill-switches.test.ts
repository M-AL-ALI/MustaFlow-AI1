/**
 * Ora Production Safety Wave 2A — Kill Switches + Privacy/Retention Audit
 *
 * Covers:
 *   1. isKillSwitchActive — env var semantics, global vs feature switches
 *   2. killSwitchBody — structure, safety, no Builder/handoff language
 *   3. Route wiring — every feature route imports and calls isKillSwitchActive
 *   4. HTTP blocking — ORA_TRANSCRIBE_DISABLED / ORA_TTS_DISABLED block with 503
 *   5. Privacy audit — logs contain no raw file content or stack traces
 *   6. Retention audit — TTL constants and scheduler registration
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// ─── Paths ────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const PUBLIC_AI_DIR = join(REPO_ROOT, "artifacts", "api-server", "src", "routes", "public-ai");
const LIB_DIR = join(REPO_ROOT, "artifacts", "api-server", "src", "lib");

function readRoute(filename: string): string {
  return readFileSync(join(PUBLIC_AI_DIR, filename), "utf-8");
}
function readLib(filename: string): string {
  return readFileSync(join(LIB_DIR, filename), "utf-8");
}
function readServerFile(filename: string): string {
  return readFileSync(join(REPO_ROOT, "artifacts", "api-server", "src", filename), "utf-8");
}

// ─── vi.mock (hoisted before imports) ────────────────────────────────────────

vi.mock("../../../lib/rateLimit", () => ({
  oraVoiceTranscribeLimiter: (_: unknown, __: unknown, next: () => void) => next(),
  oraVoiceTtsLimiter: (_: unknown, __: unknown, next: () => void) => next(),
  oraUploadLimiter: (_: unknown, __: unknown, next: () => void) => next(),
  oraImageUploadLimiter: (_: unknown, __: unknown, next: () => void) => next(),
  oraImageAnalysisLimiter: (_: unknown, __: unknown, next: () => void) => next(),
}));

vi.mock("../../../lib/public-ai/session", () => ({
  validateSession: vi.fn(() => null),
  isOraSecretConfigured: () => true,
  setSessionCookie: () => {},
  createSession: () => ({ token: "tok", payload: {} }),
  incrementFileCount: () => ({ token: "tok", payload: { fileCount: 1 } }),
  incrementImageCount: () => ({ token: "tok", payload: { imageCount: 1 } }),
  incrementMessageCount: () => ({ token: "tok", payload: { msgCount: 1 } }),
  incrementImageAnalysisCount: () => ({ token: "tok", payload: { imageAnalysisCount: 1 } }),
  getTotalCharsForSession: () => 0,
  FILE_LIMIT_VALUE: 3,
  IMAGE_LIMIT_VALUE: 2,
  MSG_LIMIT_VALUE: 20,
  IMAGE_ANALYSIS_LIMIT_VALUE: 2,
  SESSION_EXPIRY_SECONDS: 1800,
}));

vi.mock("../../../lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// ─── Router imports (after mocks) ────────────────────────────────────────────

import transcribeRouter from "../transcribe";
import ttsRouter from "../tts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(router: import("express").Router) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", router);
  return app;
}

const ALL_KILL_SWITCH_VARS = [
  "ORA_DISABLED",
  "ORA_STREAMING_DISABLED",
  "ORA_FILE_UPLOAD_DISABLED",
  "ORA_FILE_ANALYSIS_DISABLED",
  "ORA_DATASET_ANALYSIS_DISABLED",
  "ORA_IMAGE_ANALYSIS_DISABLED",
  "ORA_FILE_GENERATION_DISABLED",
  "ORA_TTS_DISABLED",
  "ORA_TRANSCRIBE_DISABLED",
  "ORA_WEB_SEARCH_DISABLED",
] as const;

function clearAllKillSwitches() {
  for (const v of ALL_KILL_SWITCH_VARS) delete process.env[v];
}

// ─── 1. isKillSwitchActive unit tests ────────────────────────────────────────

describe("isKillSwitchActive", () => {
  type Mod = typeof import("../../../lib/public-ai/ora-kill-switches");
  let mod: Mod;

  beforeEach(async () => {
    clearAllKillSwitches();
    mod = await import("../../../lib/public-ai/ora-kill-switches");
  });
  afterEach(clearAllKillSwitches);

  it("returns false for every feature when no env vars are set", () => {
    const features: Array<import("../../../lib/public-ai/ora-kill-switches").OraFeature> = [
      "all",
      "streaming",
      "file_upload",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "file_generation",
      "tts",
      "transcribe",
      "web_search",
    ];
    for (const f of features) {
      expect(mod.isKillSwitchActive(f), `feature=${f}`).toBe(false);
    }
  });

  it("ORA_DISABLED=true blocks every feature including all", () => {
    process.env.ORA_DISABLED = "true";
    const features: Array<import("../../../lib/public-ai/ora-kill-switches").OraFeature> = [
      "all",
      "streaming",
      "file_upload",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "file_generation",
      "tts",
      "transcribe",
      "web_search",
    ];
    for (const f of features) {
      expect(mod.isKillSwitchActive(f), `feature=${f}`).toBe(true);
    }
  });

  it("feature-specific env var only blocks that feature", () => {
    process.env.ORA_FILE_UPLOAD_DISABLED = "true";
    expect(mod.isKillSwitchActive("file_upload")).toBe(true);
    expect(mod.isKillSwitchActive("file_analysis")).toBe(false);
    expect(mod.isKillSwitchActive("tts")).toBe(false);
    expect(mod.isKillSwitchActive("transcribe")).toBe(false);
    expect(mod.isKillSwitchActive("streaming")).toBe(false);
  });

  it("each feature has its own independent env var", () => {
    const cases: Array<[import("../../../lib/public-ai/ora-kill-switches").OraFeature, string]> = [
      ["streaming", "ORA_STREAMING_DISABLED"],
      ["file_upload", "ORA_FILE_UPLOAD_DISABLED"],
      ["file_analysis", "ORA_FILE_ANALYSIS_DISABLED"],
      ["dataset_analysis", "ORA_DATASET_ANALYSIS_DISABLED"],
      ["image_analysis", "ORA_IMAGE_ANALYSIS_DISABLED"],
      ["file_generation", "ORA_FILE_GENERATION_DISABLED"],
      ["tts", "ORA_TTS_DISABLED"],
      ["transcribe", "ORA_TRANSCRIBE_DISABLED"],
      ["web_search", "ORA_WEB_SEARCH_DISABLED"],
    ];
    for (const [feature, envVar] of cases) {
      clearAllKillSwitches();
      process.env[envVar] = "true";
      expect(mod.isKillSwitchActive(feature), `${feature} via ${envVar}`).toBe(true);
    }
  });

  it("env var value must be exactly 'true' — other truthy strings don't activate", () => {
    process.env.ORA_TTS_DISABLED = "1";
    expect(mod.isKillSwitchActive("tts")).toBe(false);
    process.env.ORA_TTS_DISABLED = "TRUE";
    expect(mod.isKillSwitchActive("tts")).toBe(false);
    process.env.ORA_TTS_DISABLED = "yes";
    expect(mod.isKillSwitchActive("tts")).toBe(false);
  });

  it("reads env vars at call time — toggling after module load works", () => {
    expect(mod.isKillSwitchActive("transcribe")).toBe(false);
    process.env.ORA_TRANSCRIBE_DISABLED = "true";
    expect(mod.isKillSwitchActive("transcribe")).toBe(true);
    delete process.env.ORA_TRANSCRIBE_DISABLED;
    expect(mod.isKillSwitchActive("transcribe")).toBe(false);
  });
});

// ─── 2. killSwitchBody unit tests ────────────────────────────────────────────

describe("killSwitchBody", () => {
  type Mod = typeof import("../../../lib/public-ai/ora-kill-switches");
  let mod: Mod;

  beforeEach(async () => {
    mod = await import("../../../lib/public-ai/ora-kill-switches");
  });

  it("returns an object with disabled:true and the feature", () => {
    const body = mod.killSwitchBody("file_upload");
    expect(body.disabled).toBe(true);
    expect(body.feature).toBe("file_upload");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("produces distinct messages for different features", () => {
    const messages = new Set<string>();
    const features: Array<import("../../../lib/public-ai/ora-kill-switches").OraFeature> = [
      "all",
      "streaming",
      "file_upload",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "file_generation",
      "tts",
      "transcribe",
      "web_search",
    ];
    for (const f of features) {
      messages.add(mod.killSwitchBody(f).error);
    }
    expect(messages.size).toBe(features.length);
  });

  it("error messages are user-friendly — no raw Error/stack/undefined", () => {
    const features: Array<import("../../../lib/public-ai/ora-kill-switches").OraFeature> = [
      "all",
      "streaming",
      "file_upload",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "file_generation",
      "tts",
      "transcribe",
      "web_search",
    ];
    for (const f of features) {
      const { error } = mod.killSwitchBody(f);
      expect(error, `feature=${f}`).not.toContain("Error:");
      expect(error, `feature=${f}`).not.toContain("stack");
      expect(error, `feature=${f}`).not.toContain("undefined");
      expect(error, `feature=${f}`).not.toContain("null");
    }
  });

  it("kill switch messages contain no AI Builder / handoff language", () => {
    const FORBIDDEN = [
      "Builder",
      "handoff",
      "builder_handoff",
      "MustaFlow Builder",
      "Continue in Builder",
      "AI Builder",
      "ready to build",
    ];
    const features: Array<import("../../../lib/public-ai/ora-kill-switches").OraFeature> = [
      "all",
      "streaming",
      "file_upload",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "file_generation",
      "tts",
      "transcribe",
      "web_search",
    ];
    for (const f of features) {
      const { error } = mod.killSwitchBody(f);
      for (const term of FORBIDDEN) {
        expect(error, `feature=${f} must not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it("all features produce the correct feature field in the body", () => {
    const features: Array<import("../../../lib/public-ai/ora-kill-switches").OraFeature> = [
      "all",
      "streaming",
      "file_upload",
      "file_analysis",
      "dataset_analysis",
      "image_analysis",
      "file_generation",
      "tts",
      "transcribe",
      "web_search",
    ];
    for (const f of features) {
      expect(mod.killSwitchBody(f).feature).toBe(f);
    }
  });
});

// ─── 3. Route wiring source assertions ───────────────────────────────────────

describe("Kill switch route wiring (source assertions)", () => {
  it("public-ai/index.ts: uses isKillSwitchActive('all') for ORA_DISABLED", () => {
    const src = readRoute("index.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"all"');
    expect(src).toContain("killSwitchBody");
  });

  it("upload.ts: uses isKillSwitchActive('file_upload')", () => {
    const src = readRoute("upload.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"file_upload"');
    expect(src).toContain("killSwitchBody");
  });

  it("transcribe.ts: uses isKillSwitchActive('transcribe')", () => {
    const src = readRoute("transcribe.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"transcribe"');
    expect(src).toContain("killSwitchBody");
  });

  it("tts.ts: uses isKillSwitchActive('tts')", () => {
    const src = readRoute("tts.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"tts"');
    expect(src).toContain("killSwitchBody");
  });

  it("generate-file.ts: uses isKillSwitchActive('file_generation')", () => {
    const src = readRoute("generate-file.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"file_generation"');
    expect(src).toContain("killSwitchBody");
  });

  it("file-analysis.ts: uses isKillSwitchActive('file_analysis')", () => {
    const src = readRoute("file-analysis.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"file_analysis"');
    expect(src).toContain("killSwitchBody");
  });

  it("dataset-analysis.ts: uses isKillSwitchActive('dataset_analysis')", () => {
    const src = readRoute("dataset-analysis.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"dataset_analysis"');
    expect(src).toContain("killSwitchBody");
  });

  it("image-analysis.ts: uses isKillSwitchActive('image_analysis')", () => {
    const src = readRoute("image-analysis.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"image_analysis"');
    expect(src).toContain("killSwitchBody");
  });

  it("chat.ts: uses isKillSwitchActive('streaming') for streaming endpoint", () => {
    const src = readRoute("chat.ts");
    expect(src).toContain("isKillSwitchActive");
    expect(src).toContain('"streaming"');
    expect(src).toContain("killSwitchBody");
  });

  it("chat.ts: uses isKillSwitchActive('web_search') for the search decision branch", () => {
    const src = readRoute("chat.ts");
    expect(src).toContain('"web_search"');
  });

  it("kill switch check appears before session check in transcribe.ts", () => {
    const src = readRoute("transcribe.ts");
    const killPos = src.indexOf("isKillSwitchActive");
    const sessionPos = src.indexOf("validateSession(sessionToken)");
    expect(killPos).toBeGreaterThan(0);
    expect(killPos).toBeLessThan(sessionPos);
  });

  it("kill switch check appears before session check in tts.ts", () => {
    const src = readRoute("tts.ts");
    const killPos = src.indexOf("isKillSwitchActive");
    const sessionPos = src.indexOf("validateSession(sessionToken)");
    expect(killPos).toBeGreaterThan(0);
    expect(killPos).toBeLessThan(sessionPos);
  });

  it("streaming kill switch appears before ORA_STREAMING_ENABLED check", () => {
    const src = readRoute("chat.ts");
    const killPos = src.indexOf('isKillSwitchActive("streaming")');
    const enabledPos = src.indexOf('process.env.ORA_STREAMING_ENABLED !== "true"');
    expect(killPos).toBeGreaterThan(0);
    expect(killPos).toBeLessThan(enabledPos);
  });
});

// ─── 4. HTTP blocking tests ───────────────────────────────────────────────────

describe("Kill switch HTTP blocking", () => {
  beforeEach(clearAllKillSwitches);
  afterEach(clearAllKillSwitches);

  it("ORA_TRANSCRIBE_DISABLED=true → POST /public-ai/transcribe returns 503", async () => {
    process.env.ORA_TRANSCRIBE_DISABLED = "true";
    const res = await request(makeApp(transcribeRouter)).post("/api/public-ai/transcribe").send();
    expect(res.status).toBe(503);
    expect(res.body.disabled).toBe(true);
    expect(res.body.feature).toBe("transcribe");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it("ORA_TTS_DISABLED=true → POST /public-ai/tts returns 503", async () => {
    process.env.ORA_TTS_DISABLED = "true";
    const res = await request(makeApp(ttsRouter))
      .post("/api/public-ai/tts")
      .send({ text: "hello" });
    expect(res.status).toBe(503);
    expect(res.body.disabled).toBe(true);
    expect(res.body.feature).toBe("tts");
  });

  it("ORA_DISABLED=true also blocks /public-ai/transcribe (global switch)", async () => {
    process.env.ORA_DISABLED = "true";
    const res = await request(makeApp(transcribeRouter)).post("/api/public-ai/transcribe").send();
    expect(res.status).toBe(503);
    expect(res.body.disabled).toBe(true);
  });

  it("ORA_DISABLED=true also blocks /public-ai/tts (global switch)", async () => {
    process.env.ORA_DISABLED = "true";
    const res = await request(makeApp(ttsRouter)).post("/api/public-ai/tts").send({ text: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.disabled).toBe(true);
  });

  it("disabled response contains no provider stack traces", async () => {
    process.env.ORA_TRANSCRIBE_DISABLED = "true";
    const res = await request(makeApp(transcribeRouter)).post("/api/public-ai/transcribe").send();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("at Object.");
    expect(body).not.toContain("TypeError");
    expect(body).not.toContain("ReferenceError");
    expect(body).not.toContain("SyntaxError");
    expect(body).not.toContain("node_modules");
  });

  it("disabled response contains no Builder / handoff language", async () => {
    process.env.ORA_TTS_DISABLED = "true";
    const res = await request(makeApp(ttsRouter)).post("/api/public-ai/tts").send({ text: "hi" });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Builder");
    expect(body).not.toContain("handoff");
    expect(body).not.toContain("builder_handoff");
  });

  it("kill switch 503 does NOT fire when the switch is off", async () => {
    const res = await request(makeApp(transcribeRouter)).post("/api/public-ai/transcribe").send();
    expect(res.status).not.toBe(503);
  });
});

// ─── 5. Privacy audit (source assertions) ────────────────────────────────────

describe("Privacy audit — no raw content in logs", () => {
  it("upload.ts logs no raw file bytes or extractedText", () => {
    const src = readRoute("upload.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*extractedText/);
    expect(src).not.toMatch(/logger\.\w+\([^)]*file\.buffer/);
  });

  it("upload.ts logs no base64 image data", () => {
    const src = readRoute("upload.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*\.base64/);
  });

  it("transcribe.ts logs no raw audio buffer content", () => {
    const src = readRoute("transcribe.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*buf\b/);
    expect(src).not.toMatch(/logger\.\w+\([^)]*chunks/);
  });

  it("file-analysis.ts logs no raw document text", () => {
    const src = readRoute("file-analysis.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*extractedText/);
    expect(src).not.toMatch(/logger\.\w+\([^)]*fileEntry\.extractedText/);
  });

  it("remember-document.ts logs no raw document content", () => {
    const src = readRoute("remember-document.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*extractedText/);
    expect(src).not.toMatch(/logger\.\w+\([^)]*fileEntry\.extractedText/);
  });

  it("generate-file.ts does not log prompt content or file data", () => {
    const src = readRoute("generate-file.ts");
    expect(src).not.toContain("logger.info({ message");
    expect(src).not.toContain("logger.debug({ message");
    expect(src).not.toContain('fileData, "base64")\n');
    expect(src).not.toContain("logger.info({ filePrompt");
  });

  it("dataset-analysis.ts does not log raw row data", () => {
    const src = readRoute("dataset-analysis.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*rawRow/);
    expect(src).not.toMatch(/logger\.\w+\([^)]*cellValue/);
  });

  it("tts.ts does not log the text input to the TTS API", () => {
    const src = readRoute("tts.ts");
    expect(src).not.toMatch(/logger\.\w+\([^)]*\btext\b[^)]*\)/);
  });

  it("kill switch error responses contain no provider API keys or secrets", () => {
    const src = readLib("public-ai/ora-kill-switches.ts");
    expect(src).not.toContain("process.env.OPENAI_API_KEY");
    expect(src).not.toContain("API_KEY");
    expect(src).not.toContain("SECRET");
  });
});

// ─── 6. Retention audit ───────────────────────────────────────────────────────

describe("Retention audit", () => {
  it("in-memory file store has a 2-hour TTL constant", () => {
    const src = readLib("public-ai/file-store.ts");
    expect(src).toContain("TTL_MS = 2 * 60 * 60 * 1000");
  });

  it("in-memory file store runs cleanup every 5 minutes", () => {
    const src = readLib("public-ai/file-store.ts");
    expect(src).toContain("CLEANUP_INTERVAL_MS = 5 * 60 * 1000");
  });

  it("anonymous session expiry is enforced via SESSION_EXPIRY_SECONDS", () => {
    const src = readLib("public-ai/session.ts");
    expect(src).toContain("SESSION_EXPIRY_SECONDS");
  });

  it("ora_transcript retention scheduler is registered in server index", () => {
    const src = readServerFile("index.ts");
    expect(src).toContain("startOraTranscriptRetentionScheduler");
  });

  it("ora_assets retention scheduler is registered in server index", () => {
    const src = readServerFile("index.ts");
    expect(src).toContain("startOraAssetsRetentionScheduler");
  });

  it("ora_assets retention default is 90 days", () => {
    const src = readLib("ora-assets-retention.ts");
    expect(src).toContain("ORA_ASSETS_RETENTION_DAYS");
    expect(src).toContain("DEFAULT_RETENTION_DAYS = 90");
  });

  it("ora_assets retention scheduler interval is at least 24 hours", () => {
    const src = readLib("ora-assets-retention.ts");
    expect(src).toContain("24 * 60 * 60 * 1000");
  });

  it("ora_assets retention scheduler timers are unref'd", () => {
    const src = readLib("ora-assets-retention.ts");
    expect(src.match(/\.unref\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("ora_transcript retention uses ORA_TRANSCRIPT_RETENTION_DAYS env var", () => {
    const src = readLib("ora-transcript-retention.ts");
    expect(src).toContain("ORA_TRANSCRIPT_RETENTION_DAYS");
  });

  it("generate-file result is not stored in temp files — assets go to durable ora_assets", () => {
    const src = readRoute("generate-file.ts");
    expect(src).toContain("persistOraAsset");
    expect(src).not.toContain("fs.writeFile");
    expect(src).not.toContain("writeFileSync");
  });
});
