# Task 3 — One Mode control

## Result

The overflowing Lite/Eco/Power/Pro row, separate Deep button, and trailing credit
label are replaced by one compact trigger:

> Mode · Eco · 2 credits

The panel is now the single composer surface for:

- all four modes;
- each mode's one-line capability description;
- the fixed base price;
- Deep Reasoning and its adjusted price;
- the current selection.

Mode entries were removed from the `+` menu and the old hidden duplicate mode
controls were deleted.

## Pricing and behavior

`builder-mode-control.tsx` imports `builderCreditCost` and
`BUILDER_CREDIT_COST` from `lib/builder-followup-submit.ts`. It does not copy the
price numbers into a second table.

- Lite: 1 credit; Deep disabled
- Eco: 2 credits; Deep 3 credits
- Power: 5 credits; Deep 7 credits
- Pro: 10 credits; Deep 13 credits

The parent still owns `agentMode` and `deepReasoning`, so saved-mode
initialization, Lite's Deep reset, the power/pro confirmation gate, send payloads,
and charge points are unchanged.

## Mobile fit

At a 390 × 844 viewport, the open panel measured:

- x: 24 px
- y: 343 px
- width: 352 px
- height: 398.5 px
- right edge: 376 px
- bottom edge: 741.5 px

The complete panel fits inside the viewport with 14 px of right clearance and
102.5 px of bottom clearance.

## Files

- `pages/projects/components/builder-mode-control.tsx` — compact trigger and
  responsive panel.
- `pages/projects/components/queue-composer.tsx` — uses the single control and
  removes the duplicate mode surfaces.
- `builder-mode-control.test.tsx` — shared-table prices, selection callbacks,
  Lite Deep disablement, viewport class, and `+` menu exclusion.

## Evidence

- `task-3-mode-before.png` — production row before consolidation.
- `task-3-mode-panel.png` — open desktop panel.
- `task-3-mode-mobile.png` — open panel at 390 × 844.

Task 3a completed the mode-specific icon pass and replaced the panel screenshot
with the final icon-bearing UI.

## Verification

- Mustaflow TypeScript: pass
- Mode/pricing tests: 9 passed
- ESLint on changed TypeScript/TSX files: pass
- Production Vite build: pass
