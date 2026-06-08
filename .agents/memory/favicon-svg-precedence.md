---
name: Browser favicon SVG precedence
description: Why a wrong SVG favicon overrides correct PNG/ICO icons in the browser tab.
---

Browsers that support SVG favicons prefer `<link rel="icon" type="image/svg+xml">` over `.ico`/`.png` links, regardless of source order.

**Symptom seen:** the app showed a different logo in the browser tab than everywhere else. Root cause: `favicon.svg`/`logo.svg` were a stale/wrong icon while `favicon.png`/`apple-touch-icon.png` were the correct brand mark. The SVG won.

**Rule:** keep ALL favicon variants visually identical. If an SVG favicon is wrong, fixing the PNG/ICO is not enough — remove or replace the SVG link and file too.

**How to apply:** when a tab/Google favicon looks wrong, audit every `<link rel="icon">` in `index.html` (and the files in `public/`); the `image/svg+xml` one is the most likely culprit. Google search-result favicons additionally only update on Google's own re-crawl (days–weeks), independent of code changes.
