---
name: Prettier function signature collapsing
description: Prettier (printWidth:100) collapses multi-line TypeScript function signatures to a single line when they fit within the printWidth.
---

## The rule

Prettier with `printWidth: 100` and `trailingComma: "all"` will **collapse** a multi-line TypeScript function signature to a single line if the entire signature fits within 100 characters, even if you wrote it multi-line with trailing commas.

**What I wrote (rejected by Prettier):**
```ts
async function* simulateChunkStream(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
```

**What Prettier wants (97 chars — fits on one line):**
```ts
async function* simulateChunkStream(text: string, signal: AbortSignal): AsyncGenerator<string> {
```

## How to apply

- Count the full single-line signature length before deciding to split it. If it is ≤100 chars, write it on one line.
- If genuinely >100 chars, Prettier will split it — write it multi-line with trailing commas.
- **Fastest fix:** run `./node_modules/.bin/prettier --write <file>` then `git diff` to see exactly what Prettier changed. This reveals the precise formatting it expects without guessing.

**Why:** This is not a line-length enforcement quirk — it's how Prettier's "fill" algorithm works: it tries single-line first, only breaks if it exceeds printWidth.
