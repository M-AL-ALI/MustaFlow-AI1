/**
 * Raw probe: insert a valid preview session, connect to api-server:8080,
 * print EVERY byte returned, then clean up.
 * Usage: pnpm --filter @workspace/scripts run probe-preview-ws
 */
import * as net from "node:net";
import * as http from "node:http";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsAccept = (k: string) =>
  createHash("sha1").update(k + WS_MAGIC).digest("base64");
const hmacSign = (v: string) =>
  createHmac("sha256", ENCRYPTION_KEY).update(v).digest("hex");

// ── Echo server ──────────────────────────────────────────────────────────────
const echoServer = http.createServer((_, r) => r.end("ok"));
echoServer.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"] ?? "";
  console.log("[echo] upgrade received, key prefix =", key.slice(0, 8));
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      "\r\n",
  );
  socket.on("data", (d: Buffer) => console.log("[echo] frame data:", d.length, "bytes"));
  socket.on("error", (e: Error) => console.log("[echo] error:", e.message));
});
await new Promise<void>((r) => echoServer.listen(0, "127.0.0.1", r));
const echoPort = (echoServer.address() as net.AddressInfo).port;
console.log("echo port:", echoPort);

// ── DB setup ─────────────────────────────────────────────────────────────────
const sid = randomBytes(8).toString("hex");
const { rows: pr } = await pool.query<{ id: number }>(
  `INSERT INTO projects
     (name, status, builder_mode, test_container_url, test_container_status, created_at, updated_at)
   VALUES ($1,'draft','agentic',$2,'running',now(),now())
   RETURNING id`,
  ["ws-probe-project", `http://127.0.0.1:${echoPort}`],
);
const pid = pr[0]!.id;
await pool.query(
  `INSERT INTO preview_sessions
     (session_id, project_id, user_id, launch_token_hash, launch_token_used,
      cookie_issued_at, expires_at, created_at)
   VALUES ($1,$2,'probe-user','fakehash',true,now(),now()+interval'8 hours',now())`,
  [sid, pid],
);
console.log(`project id=${pid}, session_id=${sid}`);

// ── Raw WS probe ──────────────────────────────────────────────────────────────
const cookie = `__prs=${sid}.${hmacSign(`preview:${sid}`)}`;
const wsKey = randomBytes(16).toString("base64");
const host = `${sid}.preview.mustaflow.app`;
console.log("host:", host);

await new Promise<void>((resolve) => {
  const s = net.connect(8080, "127.0.0.1");
  let buf = Buffer.alloc(0);
  let printed = false;

  s.on("connect", () => {
    console.log("connected to 8080, sending upgrade…");
    s.write(
      `GET / HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Cookie: ${cookie}\r\n` +
        `\r\n`,
    );
  });

  s.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!printed && buf.length > 0) {
      printed = true;
      const raw = buf.toString("utf8", 0, Math.min(buf.length, 600));
      console.log("RAW RESPONSE (" + buf.length + " bytes):");
      console.log(JSON.stringify(raw));
    }
  });

  s.on("close", () => {
    console.log("socket closed. total bytes received:", buf.length);
    if (!printed) console.log("(no data received)");
    resolve();
  });

  s.on("error", (e: Error) => {
    console.log("socket error:", e.message);
    resolve();
  });

  setTimeout(() => {
    console.log("TIMEOUT — bytes so far:", buf.length);
    if (!printed) console.log("(no data received — socket may still be open)");
    s.destroy();
    resolve();
  }, 4000);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
await pool.query("DELETE FROM preview_sessions WHERE session_id=$1", [sid]);
await pool.query("DELETE FROM projects WHERE id=$1", [pid]);
await pool.end();
echoServer.close();
console.log("done.");
