---
name: Ora claimed-file-delivery rescue
description: Design contract for detectClaimedFileDelivery + rescueClaimedFileDelivery (hallucinated "here's your PPTX" with no file) and the regex traps found while building it.
---

The conversational path can NEVER attach a file, but the model imitates the file-builder's delivery template it sees in history from an earlier REAL delivery, producing "Here's your PPTX (11 slides)… click the card below" with no card.

**Rules:**
- Claim detection requires BOTH halves: a present-tense delivery claim AND a download affordance. A mention of a past file alone must not trigger.
- The rescue runs only on conversational replies (real file_generation branches return earlier in both routes), so real deliveries are never double-generated. No extra quota charge — the turn is already metered.
- After a delivery-STYLE assistant message, ONLY a missing-file complaint may regenerate; "ok"/"perfect" is acceptance. After a mere OFFER, affirmations regenerate too.
- On rescue failure, replace the claim with an honest correction — never leave a false delivery claim standing.

**Regex traps (both shipped as bugs first):**
- "where's the file" pattern missed "where **is** the file" — the exact incident phrasing. Complaint patterns must accept both contracted and spaced forms.
- Bare `\battached\b` as an affordance matches prose ABOUT a user upload ("summary of the attached document") → spurious PDF card. Gate to delivery forms only ("is attached", "attached below", "I've attached").

**How to apply:** any new delivery-claim/affordance/complaint cue → test contracted+spaced variants and upload-prose negatives. Vitest OOMs on api-server in Replit; the manual tsx assertion script pattern (import prompt.ts/orchestrator.ts, routeOraMessage with classifier: CLASSIFIER_FALLBACK to avoid AI calls) is the working verification gate.
