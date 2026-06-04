---
name: Ora asset Library is not built (library.tsx is the lessons gallery)
description: Avoid mistaking the public-knowledge gallery for the Ora image+file asset Library from the blueprint.
---

`artifacts/mustaflow/src/pages/library.tsx` is the **public lessons / knowledge gallery** — it calls `useListPublicKnowledge`, filters by Build/Refine/Style/Auth categories, and shows "N lessons in the public library". It is NOT the Ora "Library" described in the Ora blueprint (the unified asset home that auto-saves every generated/uploaded image and every created/uploaded file, organized by project).

The Ora sidebar's "Library" link (`components/layout/ora-sidebar.tsx`) points at `/library`, i.e. this lessons gallery — a placeholder, not the asset home.

**How to apply:** Step 8 of the Ora blueprint (in-chat images + Library) is only partially done — inline image generation message types exist in `use-ora-chat.ts`, but the auto-saving asset Library does not exist yet and must be built (do not assume library.tsx already covers it). Several upload/file-creation capabilities (file-extract, generate-file, file-builder, image-validate) currently live under `routes/public-ai/` (the signed-out trial); confirm they are wired into the authenticated `/api/ora/conversations/:id/messages` path before calling those steps complete for signed-in users.
