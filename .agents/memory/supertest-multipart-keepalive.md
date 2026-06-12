---
name: Supertest multipart upload keep-alive hang
description: Supertest's server.close() waits ~7-8 s for keep-alive socket after a multipart POST gets an early rejection (401/503). Fix is vitest.config.ts testTimeout + req.resume() + auth-before-multer ordering.
---

## Rule

When a multipart upload endpoint rejects early (401, 503) without consuming the request body, Node.js's HTTP keep-alive socket stays open for ~5-8 seconds (the default `keepAliveTimeout`). Supertest creates a fresh HTTP server per `request(app)` call and waits for `server.close()` to complete; that wait blocks until all connections close.

**Why:** The client (supertest/superagent) holds the TCP connection alive after receiving the response. Without `req.resume()` and a mechanism to tear down the socket, `server.close()` blocks for the full keepAliveTimeout before resolving.

**How to apply:**
1. **`req.resume()`** — call before every early-rejection `res.json()` to drain the incoming body stream.
2. **`res.once("finish", () => req.socket?.end())`** — half-close the server's write side after the response is written. Helps in some cases.
3. **Auth-before-rate-limiter-before-multer ordering** — rate limiter sets `X-RateLimit-*` headers which can affect socket state; auth guard must come first so unauthenticated requests get a clean 401 before any headers are touched.
4. **`vitest.config.ts` with `testTimeout: 30000`** — most reliable fix. The upload-401 supertest test inherently takes ~7-8 s due to socket behavior. The default 10 s vitest timeout has no headroom for CPU contention in a 36-file parallel batch. 30 s is safe without hiding real hangs.

The file lives at `artifacts/api-server/vitest.config.ts`.
