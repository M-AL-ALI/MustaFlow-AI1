---
name: Ora realtime voice presets & provider privacy
description: Why "Talk to Ora" Live Voice shows only product voice presets, keeps model in the session response but never renders it, and how the preset->provider mapping/override works.
---

# Ora realtime ("Talk to Ora") voice presets & provider privacy

The customer-facing Live Voice settings (website + mobile) must NEVER show the
underlying realtime model or raw provider voice ids. Only two product voice
presets are exposed: **Marine** (female, provider `marin`, the long-standing
default) and **Mustafa** (male, provider `cedar`).

## Rules

- **`model` stays in the session mint response but is transport-only.** Both the
  web and mobile hooks build the WebRTC calls URL as `${CALLS_URL}?model=...`, so
  the session response MUST keep `model`. It must never be rendered in
  `/realtime/diagnostics` or either Settings UI. Future UI work on this surface
  must not surface it.
- **The raw provider `voice` is dropped from the session response.** It had no
  functional client use. Clients receive `voicePreset` + `voiceLabel` instead.
- **Diagnostics returns only product-safe fields:** `defaultVoicePreset`,
  `defaultVoiceLabel`, and a `voices[]` list of `{key,label}` options. No `model`,
  no raw `defaultVoice`.
- **Resolution precedence (server `resolveVoiceSelection`):** a valid
  `voicePreset` wins → else legacy raw `voice` param → else `ORA_REALTIME_VOICE`
  env override → else default. The default provider voice
  (`DEFAULT_REALTIME_VOICE`) is **derived from `DEFAULT_VOICE_PRESET`** so the two
  never drift (also avoids an unused-const lint error).
- **Env override stays compatible:** an `ORA_REALTIME_VOICE` value outside the two
  presets reverse-maps to the label "Custom voice" (still never shown as a raw id).
- **Invalid `voicePreset` → Zod 400** before any upstream mint.

## Persistence keys

- Web localStorage: `mustaflow_voice_preset`
- Mobile AsyncStorage: `ora:voicePreset`

The persisted choice flows into the session mint body as `voicePreset` on both
platforms; mobile chat reloads it on focus so a settings change propagates without
restart.

**Why:** product privacy — customers must never see `gpt-realtime*`/`gpt-5`/
OpenAI/ChatGPT or raw provider voice ids (`marin`/`cedar`). Enforced by backend
realtime-session tests plus source-privacy tests over both Settings files
(grep-style assertions for forbidden strings + presence of Marine/Mustafa).
