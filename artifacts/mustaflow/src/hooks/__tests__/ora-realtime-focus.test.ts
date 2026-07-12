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
  overrides: Partial<typeof CLEAN & { assistantActive: boolean }> = {},
  acceptedTurnCount = 1,
) {
  return scoreTranscriptFocus(text, {
    focusMode,
    msSinceLastAcceptedTurn,
    acceptedTurnCount,
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
    const v = score("and what about the second one", "focused", 3_000);
    expect(v).toEqual({ accepted: true, viaWindow: true });
  });

  it("accepts a non-English follow-up inside the window (no wake word needed)", () => {
    const v = score("y el siguiente paso cual es", "focused", 3_000);
    expect(v).toEqual({ accepted: true, viaWindow: true });
  });

  it("accepts an undirected follow-up at the 6s follow-up boundary", () => {
    const v = score("and the second one", "focused", 6_000);
    expect(v).toEqual({ accepted: true, viaWindow: true });
  });

  it("accepts the first utterance exactly at the 12s cold-start boundary", () => {
    expect(score("keep going please", "focused", 12_000, {}, 0).accepted).toBe(true);
  });

  it("rejects undirected background speech while Ora is responding (no barge-in)", () => {
    // Outside the follow-up window AND Ora is mid-response: the established-speaker
    // rule is suspended so nearby chatter cannot chop her off. Only addressed or
    // directed speech may interrupt.
    const v = score("yeah i think we should grab lunch later", "focused", 8_000, {
      assistantActive: true,
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("not_addressed_or_outside_focus");
  });
});

describe("scoreTranscriptFocus — focused mode, barge-in while Ora is responding", () => {
  it("rejects nearby background speech that is not addressed or directed", () => {
    const v = score("yeah i think we should grab lunch later", "focused", 30_000, {
      assistantActive: true,
    });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("not_addressed_or_outside_focus");
  });

  it("rejects a long unaddressed sentence mid-response (never on word count)", () => {
    const v = score(
      "so anyway the meeting ran really long and everyone was pretty tired by the end",
      "focused",
      45_000,
      { assistantActive: true },
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

  it("accepts an addressed turn via the address path (no viaWindow flag) mid-response", () => {
    // While Ora is responding the established-speaker rule is suspended, so an
    // addressed turn is accepted via the address path — not the focus window — and
    // therefore carries no viaWindow flag.
    const v = score("ora hello", "focused", 60_000, { assistantActive: true });
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

describe("scoreTranscriptFocus — multilingual directed / addressed speech (outside window)", () => {
  // The scorer must not be English-only: a directed request in any supported
  // language, outside the focus window, must still make Ora respond.
  it("accepts a Spanish question (inverted + accented)", () => {
    expect(score("¿cómo funciona esto?", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a Spanish imperative by its accented lead verb", () => {
    expect(score("explícame esto por favor", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a French imperative", () => {
    expect(score("traduis ceci en anglais", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a German interrogative", () => {
    expect(score("was ist der plan", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts an Italian interrogative", () => {
    expect(score("come si fa questo", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a Turkish verb-final imperative (lead word at the END)", () => {
    expect(score("bunu açıkla", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts an Arabic question via the Arabic question mark", () => {
    expect(score("ما هذا؟", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts an Arabic imperative by its lead verb", () => {
    expect(score("اشرح لي هذا", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a Hindi yes/no question by its lead word", () => {
    expect(score("क्या यह सही है", "focused", 60_000).accepted).toBe(true);
  });

  it("accepts a Hindi verb-final imperative (lead word at the END)", () => {
    expect(score("मुझे यह समझाओ", "focused", 60_000).accepted).toBe(true);
  });

  it("still rejects non-directed non-English background speech mid-response", () => {
    const v = score("vamos a comer algo luego", "focused", 60_000, { assistantActive: true });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("not_addressed_or_outside_focus");
  });
});

describe("multilingual address tokens and question marks", () => {
  it("recognizes non-Latin Ora transliterations as an address", () => {
    expect(isAddressedToOra(["ओरा", "नमस्ते"])).toBe(true); // Devanagari (raw)
    expect(isAddressedToOra(["أورا"])).toBe(true); // Arabic with hamza (folded)
  });

  it("treats trailing non-Latin question marks as directed", () => {
    expect(looksDirected(["ما", "هذا"], "ما هذا؟")).toBe(true); // Arabic ?
    expect(looksDirected(["これは", "何"], "これは何ですか？")).toBe(true); // full-width ?
  });

  it("isAddressedOrDirected covers multilingual directed turns", () => {
    expect(isAddressedOrDirected("ما هذا؟")).toBe(true);
    expect(isAddressedOrDirected("traduis ceci")).toBe(true);
  });
});
