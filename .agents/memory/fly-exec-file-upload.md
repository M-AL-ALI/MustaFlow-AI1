---
name: Fly exec file upload
description: How to reliably write files to Fly.io containers via the exec API; why echo+base64 and stdin both fail for files > ~1KB.
---

# Fly exec file upload

## The rule
Use **chunked `printf '%s' 'CHUNK' | base64 -d >> file` appends** — one exec per chunk, 8000 base64 chars each, 400ms delay between calls.

## Why the common approaches fail

### `echo "$base64" | base64 -d > file` (what writeFileToContainer uses)
- Works for files ≤ ~1KB (634 base64 chars confirmed OK)
- Silently produces 0-byte or missing files for anything larger
- Root cause unknown (busybox echo arg limit, or Fly command string truncation) — the exec returns exit=0 but no data is written

### `stdin` field in exec JSON body
- Documented but **not functional** — Fly accepts the JSON (HTTP 200) but the `base64 -d -` command receives empty stdin, writing a 0-byte file
- The `> file` redirection runs (creating the file) but nothing is decoded into it

## Working approach

```ts
const b64 = Buffer.from(fileContent).toString("base64");
const CHUNK = 8000;   // divisible by 4 → each chunk independently decodable
const DELAY = 400;    // ms — avoids 429 rate-limit after ~22 rapid execs

await flyExec(`mkdir -p "${dir}" && : > "${fullPath}"`); // create/truncate

for (let i = 0; i < Math.ceil(b64.length / CHUNK); i++) {
  if (i > 0) await sleep(DELAY);
  const part = b64.slice(i * CHUNK, (i + 1) * CHUNK);
  await flyExec(`printf '%s' '${part}' | base64 -d >> "${fullPath}"`);
}
```

**Why chunk size must be divisible by 4:** each chunk is decoded independently by a separate `base64 -d` call and the bytes are appended. Base64 operates in 4-char groups (→ 3 bytes); splitting at non-multiples of 4 would leave dangling chars that decode incorrectly.

**Why `printf` instead of `echo`:** `echo "CHUNK"` adds a trailing newline which is fine for base64 (whitespace ignored), but `printf '%s'` is safer for any future chars. Either works once you have the chunking right.

## Rate limiting
The Fly exec API rate-limits around 22 rapid execs; 400ms delay keeps well under it. For a 197KB JS bundle (263KB base64 → 33 chunks at 8000 chars), total upload time is ~45 seconds.

## How to apply
When implementing any feature that writes files to a Fly container (file sync, app deploy, snapshot restore), use this chunked approach rather than writeFileToContainer for files > 1KB. The existing `writeFileToContainer` helper in `lib/container.ts` is only safe for tiny files.
