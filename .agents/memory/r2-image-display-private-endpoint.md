---
name: R2 image display & private-endpoint fileUrl trap
description: Why stored image fileUrl can be a non-browser-loadable private R2 endpoint, and how to display image bytes reliably
---

When `CF_R2_*` creds are set but `CF_R2_PUBLIC_URL` is NOT, `getR2Config()` (image-storage.ts) fabricates a fileUrl pointing at the PRIVATE R2 S3 endpoint (`https://<bucket>.<account>.r2.cloudflarestorage.com/<key>`). That endpoint requires SigV4 auth, so a browser `<img src>` gets 401/403 → broken image even though the job/DB row says `status: "completed"`.

**Symptom seen:** Ora inline image EDIT showed "Here's the edited image" but rendered a broken-image icon. Inline GENERATION was fine because it returns the raw provider data URI (`result.openaiUrl`) directly to the client, never the stored R2 fileUrl. EDIT displayed the stored fileUrl → broke. This is also why it was "sometimes" — generate works, edit breaks.

**Why:** the stored `fileUrl` is only browser-safe when a genuine public base URL (CF_R2_PUBLIC_URL / r2.dev public bucket / CDN) is configured. Don't assume `fileUrl.startsWith("http")` means "browser can load it".

**How to apply:**
- To display any stored image in the browser, fetch the bytes through the authenticated app route `GET /api/images/:id/file` (it resolves bytes via `getImageBuffer(storageKey, fileUrl)` — dev tmpdir OR authenticated R2 GetObject), not the raw fileUrl. That route previously hard-rejected any non-tmpdir storageKey; it must serve R2 too.
- For Ora chat messages, persist the image as a self-contained **data URL** (FileReader.readAsDataURL on the fetched blob), NOT an object URL. Object URLs are session-local and break on transcript reload; data URLs survive reload and mirror what inline generation already persists. (Auth-walled relative `/api/images/:id/file` also fails in a bare `<img>` on reload because the dev Clerk JWT cookie expires ~60s and `<img>` can't attach a bearer token.)
- `getImageBuffer` priority: dev tmpdir path (storageKey under tmpdir) → authenticated R2 GetObject (storageKey + R2 configured) → public HTTPS fetch of fileUrl.
