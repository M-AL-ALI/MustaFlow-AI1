# Task 2 — NabuFlow shell branding

## Root cause and fix

The closed navigation trigger was never hidden when the drawer opened. The trigger
has `z-50`, while the drawer is `z-40`, so its old MustaFlow image remained over
the drawer's header image. In the production before capture, both images occupied
the same top-left area:

- old trigger image: `(20.39, 18)`, `19.20 × 24`
- drawer header image: `(25, 29)`, `25.59 × 32`

The trigger now becomes `aria-hidden`, untabbable, transparent, and
non-interactive while the drawer is open. The drawer header is then the sole
visible logo. The before image rendered two effective logos; the after image
renders one.

The shell also replaces the 1,303,770-byte generic company logo with the existing
65,105-byte NabuFlow icon and labels the shell **NabuFlow**.

## Scope

- `components/layout/slide-out-nav.tsx` — NabuFlow icon and wordmark; one-logo
  open-state behavior.
- `components/onboarding-tour.tsx` and
  `components/agentic-onboarding-tooltip.tsx` — builder onboarding uses the
  NabuFlow product name.
- Project surfaces (`code-editor`, `dns-records`, `github`, integration setup,
  preview, publishing, resources) — user-facing builder references use NabuFlow.
- `builder-shell-branding.test.ts` — guards the dedicated asset, wordmark, and
  one-logo behavior.

Technical compatibility names such as `X-MustaFlow-Preview-State` remain
unchanged. Landing, company pages, Ora, and Orax were not changed.

## Screenshots

- `task-2-sidebar-before.png` — production: old MustaFlow shell and two layered
  images.
- `task-2-sidebar-after.png` — production-shaped local build: one clean
  NabuFlow logo and NabuFlow wordmark.

## Verification

- Mustaflow TypeScript: pass
- Branding tests: 2 passed
- ESLint on changed TypeScript/TSX files: pass
- Production Vite build: pass

