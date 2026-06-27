/**
 * Speaker-focus scorer unit tests (Talk to Ora realtime voice).
 *
 * These exercise the PURE focus filter that decides — in "focused" mode — whether
 * a completed transcript should make Ora reply, so nearby background speakers no
 * longer trigger a response. The scorer is duplicated BYTE-FOR-BYTE into the
 * mobile hook (artifacts/ora-mobile/hooks/useOraRealtimeVoiceNative.ts); that
 * parity is guarded by the api-server realtime-session source-string test, so
 * testing the web copy's behavior here covers both surfaces.
 */
import { describe, it, expect } from "vitest";
import {
  scoreTranscriptFocus,
  isAddressedToOra,
  looksDirected,
  isAddressedOrDirected,
  type FocusMode,
} from "../use-ora-realtime-voice";

// Defaults that pass validateUserTranscript cleanly (no echo, not too-soon).
const CLEAN = {
  sinceAssistantAudioMs: 60_000,
  recentAssistantText: "",
};

function score(
  text: string,
  focusMode: FocusMode,
  msSinceLastAcceptedTurn: number,
  overrides: Partial<typeof CLEAN> = {},
) {
  return scoreTranscriptFocus(text, {
    focusMode,
    msSinceLastAcceptedTurn,
    ...CLEAN,
    ...overrides,
  });
}

describe("scoreTranscriptFocus — normal mode (legacy open listening)", () => {
  it("accepts ordinary speech regardless of address or focus window", () => {
    expect(score("the weather is nice today", "normal", 999_999)).toEqual({
      accepted: true,
    });
  });

  it("still rejects what validateUserTranscript rejects (empty)", () => {
    expect(score("", "normal", 0).accepted).toBe(false);
  });
});

describe("scoreTranscriptFocus — focused mode, base rejections propagate", () => {
  it("empty transcript is rejected with the base reason", () => {
    const v = score("", "focused", 0);
    expect(v.accepted).toBe(false);
    expect(v.reason).toBeTruthy();
  });

  it("echo of Ora's own words is rejected (not treated as user speech)", () => {
    const v = score("hello there how can i help", "focused", 0, {
      sinceAssistantAudioMs: 200,
      recentAssistantText: "hello there how can i help",
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("echo");
  });
});

describe("scoreTranscriptFocus — focused mode, inside the focus window", () => {
  it("accepts a natural follow-up with viaWindow when engaged", () => {
    const v = score("and what about the second one", "focused", 5_000);
    expect(v).toEqual({ accepted: true, viaWindow: true });
  });

  it("accepts a non-English follow-up inside the window (no wake word needed)", () => {
    const v = score("y el siguiente paso cual es", "focused", 8_000);
    expect(v).toEqual({ accepted: true, viaWindow: true });
  });

  it("accepts exactly at the 12s window boundary", () => {
    expect(score("keep going please", "focused", 12_000).accepted).toBe(true);
  });
});

describe("scoreTranscriptFocus — focused mode, outside the focus window", () => {
  it("rejects nearby background speech that is not addressed or directed", () => {
    const v = score("yeah i think we should grab lunch later", "focused", 30_000);
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("not_addressed_or_outside_focus");
  });

  it("rejects a long unaddressed sentence on word-count alone", () => {
    const v = score(
      "so anyway the meeting ran really long and everyone was pretty tired by the end",
      "focused",
      45_000,
    );
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("not_addressed_or_outside_focus");
  });

  it("accepts when the user addresses Ora by name", () => {
    expect(score("ora what time is it", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a greeting + wake phrase (hey ora ...)", () => {
    expect(score("hey ora summarize this", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a directed question (ends with ?)", () => {
    expect(score("can you help me with this?", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a directed imperative lead word", () => {
    expect(score("explain how photosynthesis works", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a single-word voice command (stop) even when idle", () => {
    expect(score("stop", "focused", 99_999).accepted).toBe(true);
  });

  it("does NOT accept via the focus window when idle (no viaWindow flag)", () => {
    const v = score("ora hello", "focused", 60_000);
    expect(v.accepted).toBe(true);
    expect(v.viaWindow).toBeUndefined();
  });
});

describe("isAddressedToOra", () => {
  it("true when the first word is an Ora address token (incl. ASR variants)", () => {
    expect(isAddressedToOra(["ora", "hello"])).toBe(true);
    expect(isAddressedToOra(["aura", "stop"])).toBe(true);
  });

  it("true for greeting-lead + address token", () => {
    expect(isAddressedToOra(["hey", "ora"])).toBe(true);
    expect(isAddressedToOra(["okay", "ora", "go"])).toBe(true);
  });

  it("false when Ora is not named at the start", () => {
    expect(isAddressedToOra(["what", "time", "is", "it"])).toBe(false);
    expect(isAddressedToOra([])).toBe(false);
  });
});

describe("looksDirected", () => {
  it("true for a trailing question mark", () => {
    expect(looksDirected(["this", "works"], "this works?")).toBe(true);
  });

  it("true for an interrogative / imperative lead word", () => {
    expect(looksDirected(["how", "do", "i"], "how do i")).toBe(true);
    expect(looksDirected(["translate", "this"], "translate this")).toBe(true);
  });

  it("false for a plain declarative statement", () => {
    expect(looksDirected(["the", "sky", "is", "blue"], "the sky is blue")).toBe(false);
  });
});

describe("isAddressedOrDirected (barge-in / cold-start gate)", () => {
  it("true when addressed", () => {
    expect(isAddressedOrDirected("ora are you there")).toBe(true);
  });

  it("true when directed", () => {
    expect(isAddressedOrDirected("what is the capital of France?")).toBe(true);
  });

  it("false for ambient conversation", () => {
    expect(isAddressedOrDirected("i had a sandwich for lunch")).toBe(false);
  });
});
