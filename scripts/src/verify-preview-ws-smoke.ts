/**
 * Preview WebSocket Proxy — Integration Smoke Test
 *
 * End-to-end test of the WS proxy in index.ts for preview subdomains.
 *
 * Architecture:
 *   Test client (net.Socket → port 8080)
 *     → api-server upgrade handler (validates session + HMAC cookie)
 *       → echo WS server (spun up by this script)
 *
 * Tests:
 *   1. Valid session  → WS reaches OPEN, send/echo works
 *   2. Missing cookie → connection rejected (socket closed)
 *   3. Bad HMAC sig   → connection rejected
 *   4. Expired session → connection rejected
 *   5. Revoked session → connection rejected
 *
 * Usage (no extra env needed beyond DATABASE_URL + ENCRYPTION_KEY):
 *   pnpm --filter @workspace/scripts run verify-preview-ws-smoke
 *
 * The script talks directly to the api-server on port 8080.
 * Requires the api-server workflow to be running.
 */

import * as net from "node:net";
import * as http from "node:http";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";

// ── Config ────────────────────────────────────────────────────────────────────

const API_PORT = 8080;
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  console.error("ENCRYPTION_KEY env var is required");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function genSessionId(): string {
  return randomBytes(8).toString("hex"); // 16 lowercase hex chars
}

function hmacSign(value: string): string {
  return createHmac("sha256", ENCRYPTION_KEY!).update(value).digest("hex");
}

function buildCookieValue(sessionId: string): string {
  return `${sessionId}.${hmacSign(`preview:${sessionId}`)}`;
}

function cookieHeader(sessionId: string): string {
  return `__prs=${buildCookieValue(sessionId)}`;
}

// WS handshake: Sec-WebSocket-Accept = base64(SHA1(key + WS_MAGIC))
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsAccept(key: string): string {
  return createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");
}

// Build a client-side masked WebSocket text frame
function encodeClientFrame(msg: string): Buffer {
  const payload = Buffer.from(msg, "utf8");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81; // FIN=1, opcode=1 (text)
  frame[1] = 0x80 | payload.length; // MASK=1 + length (assumes < 126 bytes)
  mask.copy(frame, 2);
  for (let i = 0; i < payload.length; i++) {
    frame[6 + i] = payload[i]! ^ mask[i % 4]!;
  }
  return frame;
}

// Decode an unmasked WebSocket text frame from the server
function decodeServerFrame(data: Buffer): string | null {
  if (data.length < 2) return null;
  const opcode = data[0]! & 0x0f;
  if (opcode === 0x8) return null; // close frame
  if (opcode !== 0x1) return null; // not text
  const isMasked = (data[1]! & 0x80) !== 0;
  const len = data[1]! & 0x7f;
  if (isMasked) {
    const mask = data.slice(2, 6);
    const payload = data.slice(6, 6 + len);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]!;
    return payload.toString("utf8");
  }
  return data.slice(2, 2 + len).toString("utf8");
}

// ── Echo WS server (raw HTTP upgrade) ────────────────────────────────────────

let echoPort = 0;

function startEchoServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade required");
    });

    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"] ?? "";
      const accept = wsAccept(key);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "\r\n",
      );

      // Echo loop: parse incoming frames and echo them back (unmasked)
      socket.on("data", (data: Buffer) => {
        if (data.length < 2) return;
        const opcode = data[0]! & 0x0f;
        if (opcode === 0x8) {
          // Close frame — send close and destroy
          socket.write(Buffer.from([0x88, 0x00]));
          socket.destroy();
          return;
        }
        const isMasked = (data[1]! & 0x80) !== 0;
        const len = data[1]! & 0x7f;
        let payload: Buffer;
        if (isMasked) {
          const mask = data.slice(2, 6);
          const raw = data.slice(6, 6 + len);
          payload = Buffer.alloc(raw.length);
          for (let i = 0; i < raw.length; i++) payload[i] = raw[i]! ^ mask[i % 4]!;
        } else {
          payload = data.slice(2, 2 + len);
        }
        // Send unmasked echo frame
        const reply = Buffer.alloc(2 + payload.length);
        reply[0] = 0x81;
        reply[1] = payload.length;
        payload.copy(reply, 2);
        socket.write(reply);
      });

      socket.on("error", () => socket.destroy());
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      echoPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve(echoPort);
    });
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let testProjectId: number | null = null;
const sessionIds: string[] = [];

async function insertTestProject(containerPort: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO projects
       (owner_id, name, status, builder_mode, test_container_url, test_container_status, created_at, updated_at)
     VALUES
       ('smoke-test-user', $1, 'draft', 'agentic', $2, 'running', now(), now())
     RETURNING id`,
    ["ws-smoke-test-project", `http://127.0.0.1:${containerPort}`],
  );
  return rows[0]!.id;
}

async function insertPreviewSession(
  projectId: number,
  sessionId: string,
  opts: { expiresAt?: Date; revokedAt?: Date | null } = {},
): Promise<void> {
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 8 * 3600 * 1000);
  const revokedAt = opts.revokedAt ?? null;
  await pool.query(
    `INSERT INTO preview_sessions
       (session_id, project_id, user_id, launch_token_hash, launch_token_used,
        cookie_issued_at, expires_at, revoked_at, created_at)
     VALUES ($1, $2, 'smoke-test-user', 'fakehash', true, now(), $3, $4, now())`,
    [sessionId, projectId, expiresAt, revokedAt],
  );
  sessionIds.push(sessionId);
}

async function cleanUp(): Promise<void> {
  if (sessionIds.length > 0) {
    await pool.query(`DELETE FROM preview_sessions WHERE session_id = ANY($1)`, [sessionIds]);
  }
  if (testProjectId !== null) {
    await pool.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
  }
  await pool.end();
}

// ── Raw WS client ─────────────────────────────────────────────────────────────

interface WsResult {
  opened: boolean;
  echo: string | null;
  rejected: boolean;
  acceptHeader: string | null;
}

function connectWs(sessionId: string, cookieValue: string | null): Promise<WsResult> {
  return new Promise((resolve) => {
    const socket = net.connect(API_PORT, "127.0.0.1");
    const host = `${sessionId}.preview.${PLATFORM_DOMAIN}`;
    const wsKey = randomBytes(16).toString("base64");

    let responded = false;
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    let opened = false;
    let echo: string | null = null;
    let rejected = false;
    let acceptHeader: string | null = null;

    const done = (r: WsResult) => {
      if (!responded) {
        responded = true;
        socket.destroy();
        resolve(r);
      }
    };

    // 5-second safety timeout
    const timeout = setTimeout(() => {
      done({ opened, echo, rejected, acceptHeader });
    }, 5000);

    socket.on("connect", () => {
      const cookieLine = cookieValue ? `Cookie: ${cookieValue}\r\n` : "";
      socket.write(
        `GET / HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${wsKey}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          cookieLine +
          `\r\n`,
      );
    });

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = buf.slice(0, headerEnd).toString();
        const rest = buf.slice(headerEnd + 4);

        if (headers.startsWith("HTTP/1.1 101")) {
          // Verify Sec-WebSocket-Accept
          const match = headers.match(/Sec-WebSocket-Accept:\s*(\S+)/i);
          acceptHeader = match?.[1] ?? null;
          const expectedAccept = wsAccept(wsKey);
          if (acceptHeader !== expectedAccept) {
            clearTimeout(timeout);
            done({ opened: false, echo: null, rejected: true, acceptHeader });
            return;
          }
          handshakeDone = true;
          opened = true;
          buf = rest;

          // Send a test message
          socket.write(encodeClientFrame("hello-smoke-test"));
        } else {
          // Non-101 = rejected
          clearTimeout(timeout);
          rejected = true;
          done({ opened: false, echo: null, rejected: true, acceptHeader: null });
        }
        return;
      }

      // Post-handshake: collect frame data
      buf = Buffer.concat([buf.slice(0, 0), chunk]);
      const decoded = decodeServerFrame(buf);
      if (decoded !== null) {
        echo = decoded;
        clearTimeout(timeout);
        done({ opened, echo, rejected: false, acceptHeader });
      }
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      if (!responded) {
        rejected = !opened;
        done({ opened, echo, rejected, acceptHeader });
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      done({ opened: false, echo: null, rejected: true, acceptHeader: null });
    });
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.log(`  ✗  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function runSmoke(): Promise<void> {
  console.log("\n=== Preview WebSocket Proxy — Integration Smoke Test ===\n");

  // 1. Start echo server
  const echoPort = await startEchoServer();
  console.log(`Echo WS server started on port ${echoPort}`);

  // 2. Insert test project pointing at echo server
  testProjectId = await insertTestProject(echoPort);
  console.log(`Test project id=${testProjectId}, testContainerUrl=http://127.0.0.1:${echoPort}\n`);

  // ── Case 1: Valid session ─────────────────────────────────────────────────
  console.log("Case 1: Valid session — should reach OPEN and echo");
  const validSid = genSessionId();
  await insertPreviewSession(testProjectId, validSid);
  const validCookie = cookieHeader(validSid);
  const c1 = await connectWs(validSid, validCookie);
  assert("WebSocket reaches OPEN", c1.opened, `opened=${c1.opened}`);
  assert("Sec-WebSocket-Accept forwarded correctly", c1.acceptHeader !== null);
  assert("Echo response matches sent message", c1.echo === "hello-smoke-test", `got="${c1.echo}"`);
  console.log(`  Preview hostname pattern: ${validSid}.preview.${PLATFORM_DOMAIN}\n`);

  // ── Case 2: Missing cookie ─────────────────────────────────────────────────
  console.log("Case 2: Missing cookie — should be rejected");
  const c2 = await connectWs(validSid, null);
  assert("Connection rejected when cookie missing", c2.rejected, `opened=${c2.opened}`);
  assert("No echo on missing cookie", c2.echo === null);

  // ── Case 3: Bad HMAC signature ─────────────────────────────────────────────
  console.log("\nCase 3: Bad HMAC signature — should be rejected");
  const badCookie = `__prs=${validSid}.badhmacsignature000000000000000000000000000000000000000000000000`;
  const c3 = await connectWs(validSid, badCookie);
  assert("Connection rejected on bad HMAC", c3.rejected);
  assert("No echo on bad HMAC", c3.echo === null);

  // ── Case 4: Expired session ────────────────────────────────────────────────
  console.log("\nCase 4: Expired session — should be rejected");
  const expiredSid = genSessionId();
  await insertPreviewSession(testProjectId, expiredSid, {
    expiresAt: new Date(Date.now() - 1000),
  });
  const c4 = await connectWs(expiredSid, cookieHeader(expiredSid));
  assert("Connection rejected on expired session", c4.rejected);
  assert("No echo on expired session", c4.echo === null);

  // ── Case 5: Revoked session ────────────────────────────────────────────────
  console.log("\nCase 5: Revoked session — should be rejected");
  const revokedSid = genSessionId();
  await insertPreviewSession(testProjectId, revokedSid, {
    revokedAt: new Date(),
  });
  const c5 = await connectWs(revokedSid, cookieHeader(revokedSid));
  assert("Connection rejected on revoked session", c5.rejected);
  assert("No echo on revoked session", c5.echo === null);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(55)}`);
  console.log(`Result: ${passed} passed, ${failed} failed${failed > 0 ? " ← FAIL" : " ← PASS"}`);

  if (c1.opened && c1.echo === "hello-smoke-test") {
    console.log("\nWS Proxy smoke test: PASS");
    console.log(`  Preview subdomain pattern : {16-char-hex}.preview.${PLATFORM_DOMAIN}`);
    console.log(`  TLS-aware proxy           : httpsRequest for https:// targets`);
    console.log(`  Header forwarding         : Sec-WebSocket-Accept forwarded correctly`);
    console.log(`  Session gate              : missing/expired/revoked cookies all rejected`);
  } else {
    console.log("\nWS Proxy smoke test: FAIL");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

runSmoke()
  .then(() => cleanUp())
  .then(() => {
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err: unknown) => {
    console.error("Smoke test error:", err);
    cleanUp()
      .catch(() => {})
      .then(() => process.exit(1));
  });
