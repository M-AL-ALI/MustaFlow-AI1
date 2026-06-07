---
name: Raw-body stream handlers hang after express.json
description: Why a route that reads req.on("data"/"end") can hang forever, and the readableEnded guard that prevents it.
---

# Raw-body stream handlers hang when the body was already parsed

Any route that reads the raw request stream manually —
`await new Promise(res => { req.on("data", …); req.on("end", res); })` — will
**hang forever** if an upstream body parser already consumed the stream. The
global `express.json({limit:"10mb"})` / `express.urlencoded` in `app.ts` run for
*every* request whose `Content-Type` matches (e.g. `application/json`). By the
time the route handler attaches its `end` listener, `end` has already fired and
never fires again, so the Promise never resolves and the connection is held open
with no timeout.

**Where this bites:** `routes/public-ai/transcribe.ts` reads raw audio bytes
this way. The real voice client always sends `Content-Type: audio/webm` (which
`express.json` ignores), so production is fine — but a caller that mislabels the
request as `application/json` hangs the handler indefinitely.

**Fix / guard:** before attaching listeners, short-circuit when the stream is
already drained:
```ts
if (req.readableEnded) { resolve(); return; }
```
Then the empty-body branch returns a fast 400 instead of hanging.

**Why:** found during an Ora end-to-end sweep — a `POST /transcribe` with
`application/json` body timed out at 120s. The 502-on-junk-audio path proved
Whisper wiring was healthy; only the wrong-content-type path hung.

**How to apply:** any new endpoint that manually reads `req` as a stream (file
uploads, audio, webhooks) and is mounted *after* the global JSON/urlencoded
parsers must either (a) be registered before those parsers with its own
`express.raw({type: …})`, or (b) include the `req.readableEnded` guard so a
mislabeled content-type can't hang it.
