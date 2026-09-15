import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHtmlBytes } from "../src/preview-url-rewrite";

const MAX_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function closedBody(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function bodyWithHangingCancel(chunks: readonly Uint8Array[] = []) {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel,
  });
  return { body, cancel };
}

describe("bounded preview HTML buffering", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
  });

  afterEach(() => {
    try {
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("concatenates chunks at the byte limit and releases the reader", async () => {
    const body = closedBody([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]);

    const result = await readHtmlBytes(body, 5);

    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    expect(result.buffer.byteLength).toBeLessThanOrEqual(5);
    expect(body.locked).toBe(false);
  });

  it("ignores empty chunks between payload chunks", async () => {
    const body = closedBody([
      new Uint8Array(0),
      new Uint8Array([1]),
      new Uint8Array(0),
      new Uint8Array([2]),
      new Uint8Array(0),
    ]);

    const result = await readHtmlBytes(body, 2);

    expect(Array.from(result)).toEqual([1, 2]);
    expect(body.locked).toBe(false);
  });

  it("returns an empty result when every chunk is empty", async () => {
    const body = closedBody([new Uint8Array(0), new Uint8Array(0)]);

    const result = await readHtmlBytes(body);

    expect(result.byteLength).toBe(0);
    expect(body.locked).toBe(false);
  });

  it("accepts a zero limit for empty chunks", async () => {
    const body = closedBody([new Uint8Array(0), new Uint8Array(0)]);

    const result = await readHtmlBytes(body, 0);

    expect(result.byteLength).toBe(0);
    expect(result.buffer.byteLength).toBe(0);
    expect(body.locked).toBe(false);
  });

  it("rejects payload bytes at a zero limit as oversized input", async () => {
    const { body, cancel } = bodyWithHangingCancel([new Uint8Array([1])]);

    await expect(readHtmlBytes(body, 0)).rejects.toMatchObject({
      code: "preview_html_too_large",
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("copies incoming storage before the next read and keeps the result independent", async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4]);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(first);
            return;
          }
          first.fill(9);
          controller.enqueue(second);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const result = await readHtmlBytes(body, 4);

    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    expect(result.buffer).not.toBe(first.buffer);
    expect(result.buffer).not.toBe(second.buffer);
    first.fill(7);
    second.fill(8);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    expect(body.locked).toBe(false);
  });

  it("copies small views without returning their large backing allocation", async () => {
    const backing = new Uint8Array(2 * 1024 * 1024);
    backing.set([11, 12, 13, 14], 1024);
    const view = backing.subarray(1024, 1028);
    const body = closedBody([view]);

    const result = await readHtmlBytes(body, 32);

    expect(Array.from(result)).toEqual([11, 12, 13, 14]);
    expect(result.buffer).not.toBe(backing.buffer);
    expect(result.buffer.byteLength).toBeLessThanOrEqual(32);
    backing.fill(0);
    expect(Array.from(result)).toEqual([11, 12, 13, 14]);
    expect(body.locked).toBe(false);
  });

  it("rejects oversize input without waiting for cancellation to settle", async () => {
    const { body, cancel } = bodyWithHangingCancel([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ]);

    await expect(readHtmlBytes(body, 3)).rejects.toMatchObject({
      code: "preview_html_too_large",
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("rejects an already-aborted signal without leaving a reader locked", async () => {
    const controller = new AbortController();
    controller.abort();
    const body = closedBody([new Uint8Array([1])]);

    await expect(readHtmlBytes(body, 8, { signal: controller.signal })).rejects.toMatchObject({
      code: "preview_html_read_aborted",
    });

    expect(body.locked).toBe(false);
  });

  it("aborts a pending read without waiting for cancellation to settle", async () => {
    const controller = new AbortController();
    const { body, cancel } = bodyWithHangingCancel();
    const result = readHtmlBytes(body, 8, { signal: controller.signal });
    const rejection = expect(result).rejects.toMatchObject({
      code: "preview_html_read_aborted",
    });

    expect(body.locked).toBe(true);
    controller.abort();
    await rejection;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each([
    { label: "default", timeoutMs: undefined, deadlineMs: DEFAULT_TIMEOUT_MS },
    { label: "explicit maximum", timeoutMs: DEFAULT_TIMEOUT_MS, deadlineMs: DEFAULT_TIMEOUT_MS },
    { label: "short", timeoutMs: 25, deadlineMs: 25 },
  ])(
    "times out a pending read at the $label deadline even when cancel hangs",
    async ({ timeoutMs, deadlineMs }) => {
      const { body, cancel } = bodyWithHangingCancel();
      const result = readHtmlBytes(body, 8, timeoutMs === undefined ? {} : { timeoutMs });
      const rejection = expect(result).rejects.toMatchObject({
        code: "preview_html_read_timeout",
      });

      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(cancel).not.toHaveBeenCalled();
      expect(body.locked).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    },
  );

  it("checks the deadline before another read even when the timer has not fired", async () => {
    let elapsedMs = 0;
    let pulls = 0;
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            elapsedMs = 26;
            vi.setSystemTime(elapsedMs);
            controller.enqueue(new Uint8Array(0));
          } else {
            controller.close();
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );

    await expect(readHtmlBytes(body, 8, { timeoutMs: 25 })).rejects.toMatchObject({
      code: "preview_html_read_timeout",
    });

    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each([
    { withData: false, elapsedMs: 25 },
    { withData: true, elapsedMs: 25 },
    { withData: false, elapsedMs: 26 },
    { withData: true, elapsedMs: 26 },
  ])(
    "rejects EOF at/after the deadline without a timer callback: $withData/$elapsedMs",
    async ({ withData, elapsedMs }) => {
      vi.setSystemTime(0);
      let sentData = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (withData && !sentData) {
              sentData = true;
              controller.enqueue(new Uint8Array([1]));
              return;
            }
            vi.setSystemTime(elapsedMs);
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );

      await expect(readHtmlBytes(body, 8, { timeoutMs: 25 })).rejects.toMatchObject({
        code: "preview_html_read_timeout",
      });
      expect(body.locked).toBe(false);
    },
  );

  it.each([false, true])(
    "rejects cancellation delivered with EOF: prior bytes %s",
    async (withData) => {
      const abort = new AbortController();
      let sentData = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (withData && !sentData) {
              sentData = true;
              controller.enqueue(new Uint8Array([1]));
              return;
            }
            controller.close();
            abort.abort();
          },
        },
        { highWaterMark: 0 },
      );

      await expect(readHtmlBytes(body, 8, { signal: abort.signal })).rejects.toMatchObject({
        code: "preview_html_read_aborted",
      });
      expect(body.locked).toBe(false);
    },
  );

  it("accepts the maximum byte limit", async () => {
    const body = closedBody([new Uint8Array([1])]);

    const result = await readHtmlBytes(body, MAX_LIMIT);

    expect(Array.from(result)).toEqual([1]);
    expect(result.buffer.byteLength).toBeLessThanOrEqual(MAX_LIMIT);
    expect(body.locked).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, MAX_LIMIT + 1])(
    "rejects an invalid byte limit before acquiring a reader: %s",
    async (limit) => {
      const body = closedBody([]);
      const getReader = vi.spyOn(body, "getReader");

      await expect(readHtmlBytes(body, limit)).rejects.toThrow(RangeError);

      expect(getReader).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    },
  );

  it.each([
    0,
    -1,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    DEFAULT_TIMEOUT_MS + 1,
  ])("rejects an invalid timeout: %s", async (timeoutMs) => {
    const body = closedBody([]);

    await expect(readHtmlBytes(body, 8, { timeoutMs })).rejects.toThrow(RangeError);

    expect(body.locked).toBe(false);
  });
});
