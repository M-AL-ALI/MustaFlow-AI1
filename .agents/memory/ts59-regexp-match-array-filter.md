---
name: TS 5.9 RegExpMatchArray filter-callback never
description: TypeScript 5.9 narrows (RegExpMatchArray | never[]) so that .filter() callback params become `never`; explicit string[] annotation fixes it.
---

## The rule

When you write `const xs = str.match(/foo/gi) ?? []` and then call `xs.filter(x => ...)`, TypeScript 5.9 may narrow the element type of `xs` to `never` inside the callback because it sees `RegExpMatchArray | never[]` and resolves the callback parameter as `string | never = never` in certain inference paths.

**Fix:** add an explicit `: string[]` annotation on the match result:

```typescript
// Before — TS 5.9 error: Property 'match' does not exist on type 'never'
const tags = html.match(/<input[^>]*>/gi) ?? [];

// After — explicit annotation restores correct inference
const tags: string[] = html.match(/<input[^>]*>/gi) ?? [];
```

**Why:** `RegExpMatchArray` has special TypeScript lib typing; the `?? []` fallback literal `[]` is inferred as `never[]`, and TS 5.9's tighter union narrowing resolves the callback element type to `never` instead of `string`. The annotation short-circuits inference.

**How to apply:** Any time you see `TS2339: Property '...' does not exist on type 'never'` inside a `.filter()`, `.map()`, or `.forEach()` callback whose array came from `String.prototype.match()`, add `: string[]` to the match variable.
