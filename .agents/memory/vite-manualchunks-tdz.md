---
name: Vite manualChunks TDZ crash
description: Hand-rolled rollupOptions.output.manualChunks that splits interdependent vendor libs causes "Cannot access 'X' before initialization" runtime crashes that kill the whole app.
---

# Vite manualChunks circular-dependency TDZ crash

Hand-authored `rollupOptions.output.manualChunks` in `artifacts/mustaflow/vite.config.ts` that bucketed strongly-coupled vendor graphs into separate chunks (recharts + `d3-*`; remark/rehype/unified/micromark; `@xyflow`/`@dagrejs`) created cross-chunk circular imports. At runtime ESM live-bindings hit a temporal-dead-zone fault — `Uncaught ReferenceError: Cannot access 'M' before initialization at charts-*.js` — which crashes during module init **before React mounts**, so the page shows only the prerendered static body in an otherwise-empty `<div id="root">`.

**Why:** Splitting modules that import each other across manual chunk boundaries can produce an init order where a top-level `const`/`let` in chunk A is read before chunk A finished evaluating. Rollup's *default* chunking is graph-aware and co-locates circularly-dependent modules, guaranteeing correct init order. The crash worsened because the `charts` chunk was statically preloaded by the main entry, so it broke every route, not just chart pages.

**How to apply:** Do NOT reintroduce a custom `manualChunks` map without exhaustive chunk-graph testing. Route-level code splitting via `lazy()`/dynamic import is independent of `manualChunks` and keeps working — recharts ends up co-located into the lazy billing page chunk on its own. If a future "reduce initial JS" task tempts hand-splitting vendor libs, prefer per-route lazy imports instead.

**Related gotcha:** `scripts/check-bundle-size.mjs` normalizes preload hrefs by anchoring on the `/assets/` segment. The earlier `/^\/[^/]*\//` regex wrongly stripped the `assets/` dir itself for root (non-base-prefixed) hrefs, so every file resolved to 0 bytes and the budget guard silently passed (false green). It now hard-fails if matched preload links all resolve to 0 bytes.
