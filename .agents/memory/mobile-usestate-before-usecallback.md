---
name: Mobile useState must precede useCallback dep arrays
description: TypeScript TS2448/TS2454 when useState value used in useCallback dep array declared later in same component body.
---

## Rule
In mobile (and any TSC strict component), a `useState` destructured value used in a `useCallback` **dependency array** must be declared BEFORE the `useCallback` call in the component function body.

## Why
`useCallback(fn, deps)` evaluates `deps` EAGERLY at hook-call time — it's the second argument, not inside the closure. TypeScript's strict mode detects the `const` binding is in the TDZ and raises TS2448/TS2454.

This is DIFFERENT from `useRef`: `useRef` bindings can be declared later and still accessed from within callback bodies, because the body runs lazily (on user interaction, after the full render).

## How to apply
Whenever `handleSend` or another early `useCallback` needs to reference a `useState` value in its dep array, declare the `useState` ABOVE the `useCallback`. Add a comment explaining the ordering constraint so future maintainers don't move it back.

Example:
```ts
// Declared before handleSend so it's available in handleSend's dep array
// (dep arrays are evaluated eagerly, unlike callback bodies).
const [activeArtifactRef, setActiveArtifactRef] = useState<...>(null);

const handleSend = useCallback(async () => {
  if (activeArtifactRef && ...) { ... }
}, [input, attachment, sending, sendMessage, activeArtifactRef]);
```
