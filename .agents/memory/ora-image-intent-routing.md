---
name: Ora image-intent routing is pattern-only
description: Why Ora sometimes refuses to generate images and where the single source of truth lives
---

Ora image generation has NO frontend intent override and NO dedicated frontend endpoint — the web chat posts every non-analysis message to the non-streaming `/public-ai/chat`, and the backend router (`routeOraMessage` in orchestrator.ts) is the SOLE decider of image intent via `ORA_IMAGE_PATTERNS` / `isImageGenerationRequest`.

**Symptom:** Ora replies "I can generate it, but I can't produce the actual image in this chat turn." That reply is the CONVERSATIONAL model talking — it means the image fast-path did NOT fire (pattern miss), so the request fell through to the chat model. The system prompt tells the model it CAN generate images and to never refuse, but the model hedges anyway. So a refusal is almost always a routing/pattern-coverage gap, NOT a provider/config problem and NOT the model being "broken."

**Why:** the patterns historically required a recognized verb + an explicit "visual noun", so natural phrasings missed: "draw a dog" (no visual noun), "a logo for my mechanic app" (no verb), "give me a banner" ("give" not a verb in the list). Provider config (`isImageProviderConfigured()`) and the image branch in chat.ts were fine the whole time.

**How to apply:**
- Diagnose refusals by testing `isImageGenerationRequest(phrase)` directly, not by reading provider/env code. If it returns false, broaden patterns; don't touch the provider.
- When broadening, guard against figurative/instructional false positives: idiom exclusion list after drawing verbs (conclusion/point/concept/idea/line/...), a `(?<!how (to|do i|...) )` lookbehind for tutorials ("how to paint a room"), and anchor any verb-less "a <noun> for/of ..." pattern to `^` so mid-sentence statements ("I used a logo for my app") don't match.
- Router fast-path ORDER matters: file_generation + file-continuation run BEFORE image, image runs BEFORE search. Keep image asks from being eaten by file-continuation ("generate it") or search.
- `image_editing` tool is status `"planned"` in the registry — chat-text "modify this image" does NOT route through the router; editing happens via the inline Edit button → `/images/:id/edit` (shared with Image Studio, which DOES charge credits). Image analysis (`image_analysis`) is live and fires on uploads.
