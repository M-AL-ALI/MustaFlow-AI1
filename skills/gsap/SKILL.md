---
name: gsap
description: Animate with GSAP — timelines, ScrollTrigger, and high-performance tweens for any DOM element.
triggers: [gsap, greensock, scrolltrigger, tween]
---

# GSAP skill

Use for complex, scroll-driven, or imperative animations where Framer Motion's declarative model is awkward — long timelines, hero animations, scroll-pinning, SVG morphs.

## Install

```sh
npm install gsap
```

ScrollTrigger and ScrollSmoother used to be paid Club plugins — they are now free under the standard GSAP license.

## Basic tween

```ts
import gsap from "gsap";
gsap.to(".box", { x: 200, duration: 1, ease: "power2.out" });
gsap.from(".hero h1", { opacity: 0, y: 30, duration: 0.6, stagger: 0.1 });
```

## Timelines

```ts
const tl = gsap.timeline({ defaults: { duration: 0.5, ease: "power2.out" } });
tl.from(".logo", { y: -20, opacity: 0 })
  .from(".nav li", { opacity: 0, x: -10, stagger: 0.08 }, "-=0.2")
  .from(".hero", { opacity: 0, scale: 0.95 });
```

## In React

Always create animations inside `useGSAP()` (from `@gsap/react`) so they're scoped + auto-cleaned.

```tsx
import { useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

function Box() {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      gsap.from(".box", { x: -100, opacity: 0, duration: 0.6 });
    },
    { scope: root },
  );
  return (
    <div ref={root}>
      <div className="box w-24 h-24 bg-red-500" />
    </div>
  );
}
```

## Do

- Use timelines for sequenced animations — they're easier to read than chained `.then(...)`.
- Use `gsap.context()` (or `useGSAP`) in React so animations clean up on unmount.
- Use `gsap.set(...)` for non-animated style writes (initial states without flash).
- For SVG, animate `attr: { ... }` and transform-origin via `transformOrigin: "50% 50%"`.

## Don't

- Don't forget to clean up in React — leaked tweens keep refs to nodes and cause memory issues.
- Don't animate the same property with both GSAP and React state — pick one source of truth.

## Examples

### ScrollTrigger pin

```ts
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);

gsap.to(".panel", {
  xPercent: -300,
  ease: "none",
  scrollTrigger: {
    trigger: ".container",
    pin: true,
    scrub: 1,
    end: "+=2000",
  },
});
```

### Hero with stagger

```ts
gsap.from(".hero > *", {
  opacity: 0,
  y: 40,
  duration: 0.8,
  stagger: 0.12,
  ease: "expo.out",
});
```

### Counter

```ts
const obj = { v: 0 };
gsap.to(obj, {
  v: 1000,
  duration: 2,
  onUpdate: () => (counterEl.textContent = Math.round(obj.v).toString()),
});
```
