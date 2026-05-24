---
name: framer-motion
description: Add animations and gestures with Framer Motion (motion/react) — declarative animate, layout, and exit transitions.
triggers: [framer motion, framer-motion, motion/react, animation, animate]
---

# Framer Motion skill

Use for declarative React animations — page transitions, list reorders, micro-interactions, drag, gestures. The modern import is `motion/react` (the package is now published as `motion`).

## Install

```sh
npm install motion
```

```tsx
import { motion, AnimatePresence } from "motion/react";
```

## Core idea

Replace any HTML element with its `motion.` counterpart (`motion.div`, `motion.button`, ...). Add `initial`, `animate`, `exit`, `transition`, `whileHover`, `whileTap`, `drag`, `layout` props.

## Do

- Use `layout` for automatic FLIP animations when an element's size/position changes.
- Wrap conditionally-rendered children in `<AnimatePresence>` to animate exit.
- Prefer transform/opacity for performance (avoid animating `width`/`height` directly — use `layout`).
- For complex sequences, use `useAnimate()` for an imperative API.
- Use `prefers-reduced-motion` (`useReducedMotion()` hook) to respect user settings.

## Don't

- Don't put `AnimatePresence` _inside_ a conditional render — it must be mounted while the child mounts/unmounts so it can see the unmount.
- Don't animate every element on the page — pick moments that matter.

## Examples

### Fade-in card

```tsx
import { motion } from "motion/react";

<motion.div
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.25, ease: "easeOut" }}
  className="p-4 bg-white rounded shadow"
>
  Hello
</motion.div>;
```

### Modal with exit animation

```tsx
import { AnimatePresence, motion } from "motion/react";

<AnimatePresence>
  {open && (
    <motion.div
      key="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/50"
      onClick={() => setOpen(false)}
    />
  )}
</AnimatePresence>;
```

### Layout animation on list reorder

```tsx
{
  items.map((item) => (
    <motion.li key={item.id} layout className="p-2 border-b">
      {item.text}
    </motion.li>
  ));
}
```

### Drag with constraints

```tsx
<motion.div
  drag
  dragConstraints={{ left: -100, right: 100, top: -50, bottom: 50 }}
  whileDrag={{ scale: 1.05 }}
  className="w-20 h-20 bg-blue-500 rounded"
/>
```

### Reduced motion

```tsx
import { useReducedMotion } from "motion/react";
const reduce = useReducedMotion();
<motion.div animate={{ x: reduce ? 0 : 100 }} />;
```
