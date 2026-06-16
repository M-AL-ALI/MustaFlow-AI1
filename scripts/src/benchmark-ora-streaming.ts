/**
 * Ora Live Streaming Benchmark
 *
 * Measures key streaming performance metrics against the local dev server.
 * Run with: pnpm --filter @workspace/scripts run benchmark-streaming
 *
 * Required: ORA_STREAMING_ENABLED=true on the API server.
 * Optional: ORA_BENCHMARK_RUNS=10 (default: 5), ORA_BENCHMARK_URL (default: localhost)
 *
 * Metrics reported:
 *   TTFB          — time from request sent to first byte of SSE response
 *   TTFT          — time from request sent to first token event
 *   Total time    — full round-trip (request → done event)
 *   Throughput    — tokens/second during the stream
 *   Completion %  — % of runs that received a `done` event
 *   Fallback %    — % of runs that received a JSON streamingFallback response
 *   Error %       — % of runs that received a mid-stream error event
 *   Dup count     — number of runs where the same token text appeared twice in sequence
 *   Stuck count   — number of runs where >5 s elapsed between consecutive tokens
 */

const BASE = process.env.ORA_BENCHMARK_URL ?? `http://localhost:${process.env.PORT ?? 8080}`;
const RUNS = parseInt(process.env.ORA_BENCHMARK_RUNS ?? "5", 10);
const PROMPT = process.env.ORA_BENCHMARK_PROMPT ?? "Explain what a REST API is in 3 sentences.";
// A pre-created session token for testing. Leave blank to auto-create one.
const SESSION_COOKIE = process.env.ORA_BENCHMARK_SESSION ?? "";

interface RunResult {
  run: number;
  ttfbMs: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  tokenCount: number;
  throughputTps: number | null;
  completed: boolean;
  fallback: boolean;
  midStreamError: boolean;
  dupCount: number;
  stuckCount: number;
  error: string | null;
}

function ms(start: number): number {
  return Math.round(performance.now() - start);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? (sorted[mid] ?? 0) : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function ensureSession(): Promise<string> {
  if (SESSION_COOKIE) return SESSION_COOKIE;
  const res = await fetch(`${BASE}/api/public-ai/session`, { method: "POST" });
  if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie") ?? "";
  const match = cookie.match(/ora-session=([^;]+)/);
  if (!match) throw new Error("No ora-session cookie in session response");
  return match[1]!;
}

async function runOnce(run: number, sessionCookie: string): Promise<RunResult> {
  const result: RunResult = {
    run,
    ttfbMs: null,
    ttftMs: null,
    totalMs: null,
    tokenCount: 0,
    throughputTps: null,
    completed: false,
    fallback: false,
    midStreamError: false,
    dupCount: 0,
    stuckCount: 0,
    error: null,
  };

  const t0 = performance.now();
  let firstTokenAt: number | null = null;
  let lastTokenAt: number | null = null;
  let prevToken: string | null = null;

  try {
    const res = await fetch(`${BASE}/api/public-ai/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `ora-session=${sessionCookie}`,
      },
      body: JSON.stringify({
        message: PROMPT,
        messages: [],
        mode: "instant",
        referenceSavedMemories: false,
        referenceChatHistory: false,
      }),
    });

    result.ttfbMs = ms(t0);

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // JSON fallback (503 streaming disabled or specialist tool)
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      result.fallback = !!body.streamingFallback;
      result.totalMs = ms(t0);
      return result;
    }

    if (!res.body) {
      result.error = "No response body";
      result.totalMs = ms(t0);
      return result;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType: string | null = null;
        let dataLine: string | null = null;

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
        }
        if (!dataLine) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(dataLine) as Record<string, unknown>;
        } catch {
          continue;
        }

        const type = eventType ?? (parsed.type as string | undefined);
        if (!type) continue;

        if (type === "token") {
          const text = (parsed as { text?: string }).text ?? "";
          const now = performance.now();

          if (firstTokenAt === null) {
            firstTokenAt = now;
            result.ttftMs = Math.round(now - t0);
          }

          // Duplicate detection: same token text as previous
          if (text === prevToken && text.trim().length > 0) {
            result.dupCount += 1;
          }

          // Stuck detection: >5 s gap between consecutive tokens
          if (lastTokenAt !== null && now - lastTokenAt > 5000) {
            result.stuckCount += 1;
          }

          prevToken = text;
          lastTokenAt = now;
          result.tokenCount += 1;
        } else if (type === "done") {
          result.completed = true;
        } else if (type === "error") {
          if (result.tokenCount > 0) {
            result.midStreamError = true;
          }
        }
      }
    }

    const endAt = performance.now();
    result.totalMs = Math.round(endAt - t0);

    if (firstTokenAt !== null && lastTokenAt !== null && result.tokenCount > 1) {
      const streamDurationSec = (lastTokenAt - firstTokenAt) / 1000;
      result.throughputTps =
        streamDurationSec > 0
          ? Math.round((result.tokenCount / streamDurationSec) * 10) / 10
          : null;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    result.totalMs = ms(t0);
  }

  return result;
}

function pad(s: string | number, width: number, right = false): string {
  const str = String(s);
  const spaces = " ".repeat(Math.max(0, width - str.length));
  return right ? str + spaces : spaces + str;
}

function fmtMs(v: number | null): string {
  return v === null ? "   —  " : `${v} ms`;
}

function fmtTps(v: number | null): string {
  return v === null ? "  —  " : `${v} t/s`;
}

async function main(): Promise<void> {
  console.log(`\nOra Streaming Benchmark`);
  console.log(`  Server : ${BASE}`);
  console.log(`  Prompt : ${PROMPT.slice(0, 60)}${PROMPT.length > 60 ? "…" : ""}`);
  console.log(`  Runs   : ${RUNS}\n`);

  let sessionCookie: string;
  try {
    sessionCookie = await ensureSession();
    console.log(`  Session acquired.\n`);
  } catch (err) {
    console.error(`  Session error: ${err instanceof Error ? err.message : err}`);
    console.error(`  Make sure the API server is running and ORA_STREAMING_ENABLED=true.\n`);
    process.exit(1);
  }

  const results: RunResult[] = [];

  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`  Run ${i}/${RUNS}... `);
    const r = await runOnce(i, sessionCookie);
    results.push(r);

    if (r.error) {
      console.log(`ERROR: ${r.error}`);
    } else if (r.fallback) {
      console.log(`FALLBACK (streaming unavailable)`);
    } else if (r.completed) {
      console.log(
        `done  TTFB=${fmtMs(r.ttfbMs)} TTFT=${fmtMs(r.ttftMs)} total=${fmtMs(r.totalMs)} tokens=${r.tokenCount} tps=${fmtTps(r.throughputTps)}`,
      );
    } else {
      console.log(`incomplete  totalMs=${r.totalMs}`);
    }

    // Small delay between runs to avoid overwhelming the server
    if (i < RUNS) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // ── Aggregates ────────────────────────────────────────────────────────────

  const completed = results.filter((r) => r.completed);
  const ttfbs = completed.map((r) => r.ttfbMs).filter((v): v is number => v !== null);
  const ttfts = completed.map((r) => r.ttftMs).filter((v): v is number => v !== null);
  const totals = completed.map((r) => r.totalMs).filter((v): v is number => v !== null);
  const tpsList = completed.map((r) => r.throughputTps).filter((v): v is number => v !== null);

  const completionPct = Math.round((completed.length / RUNS) * 100);
  const fallbackPct = Math.round((results.filter((r) => r.fallback).length / RUNS) * 100);
  const errorPct = Math.round((results.filter((r) => r.midStreamError).length / RUNS) * 100);
  const totalDups = results.reduce((s, r) => s + r.dupCount, 0);
  const totalStuck = results.reduce((s, r) => s + r.stuckCount, 0);

  console.log(`\n${"─".repeat(56)}`);
  console.log(`  Metric                  Median      Avg`);
  console.log(`${"─".repeat(56)}`);
  console.log(`  TTFB (ms)           ${pad(median(ttfbs), 10)}  ${pad(Math.round(avg(ttfbs)), 8)}`);
  console.log(`  TTFT (ms)           ${pad(median(ttfts), 10)}  ${pad(Math.round(avg(ttfts)), 8)}`);
  console.log(
    `  Total time (ms)     ${pad(median(totals), 10)}  ${pad(Math.round(avg(totals)), 8)}`,
  );
  console.log(
    `  Throughput (t/s)    ${pad(median(tpsList).toFixed(1), 10)}  ${pad(avg(tpsList).toFixed(1), 8)}`,
  );
  console.log(`${"─".repeat(56)}`);
  console.log(`  Completion rate         ${completionPct}%`);
  console.log(`  Fallback rate           ${fallbackPct}%`);
  console.log(`  Mid-stream error rate   ${errorPct}%`);
  console.log(`  Duplicate tokens        ${totalDups}`);
  console.log(`  Stuck-stream count      ${totalStuck}`);
  console.log(`${"─".repeat(56)}\n`);

  // Exit non-zero if completion rate is below 90% (stretch target: 97%)
  if (completionPct < 90) {
    console.error(`  FAIL: completion rate ${completionPct}% is below 90% threshold.\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
