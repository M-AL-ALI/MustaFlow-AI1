---
name: OpenAI image model family differences
description: gpt-image-1 and dall-e-3 have incompatible API parameters and response formats; how to handle both.
---

## The rule

Default the image provider to `gpt-image-1`, not `dall-e-3`. The Replit `OPENAI_API_KEY` environment has the gpt-image-\* family but NOT dall-e-3.

## Model family differences

| Feature           | gpt-image-1 / gpt-image-_ / chatgpt-image-_ | dall-e-3                      |
| ----------------- | ------------------------------------------- | ----------------------------- |
| Quality values    | `low`, `medium`, `high`                     | `standard`, `hd`              |
| Size 16:9         | `1536x1024`                                 | `1792x1024`                   |
| Size 9:16         | `1024x1536`                                 | `1024x1792`                   |
| `style` param     | Not supported — 400 unknown_parameter       | Supported (`vivid`/`natural`) |
| `response_format` | Not supported — 400 unknown_parameter       | Supported                     |
| Response data     | `b64_json` (base64 data URI)                | `url` (HTTPS URL)             |
| `revised_prompt`  | Not returned                                | Returned                      |

## How to handle both

- `image-provider.ts`: use `isGptImageFamily(model)` to branch quality/size mapping
- Omit `response_format` from API calls entirely (gpt-image-1 rejects it; dall-e-3 defaults to "url" without it)
- Try with `style` first; catch `code === "unknown_parameter" && param === "style"` and retry without
- On response: check `item.url` first, then `item.b64_json`; wrap b64 as `data:image/png;base64,...`
- `image-storage.ts`: `resolveRawBuffer()` decodes data URIs directly instead of fetching

**Why:** The Replit dev environment OPENAI_API_KEY routes to a newer API tier that only exposes gpt-image-\* models. Hard-coding `dall-e-3` as default causes "model does not exist" errors. Override with `IMAGE_MODEL=dall-e-3` if the deployment key explicitly has legacy DALL-E access.

**How to apply:** Any time image generation is configured, check `IMAGE_MODEL` env var first (explicit override); otherwise default to `gpt-image-1`. Use `isGptImageFamily()` helper for quality/size branching.
