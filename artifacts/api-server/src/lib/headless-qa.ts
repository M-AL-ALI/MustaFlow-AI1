import http from "http";
import net from "net";
import type { FileSnapshotEntry } from "@workspace/db";
import { logger } from "./logger";

export interface QAResult {
  passed: boolean;
  errors: string[];
  stepsRun: number;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

/**
 * Spin up an in-process HTTP server serving `projectFiles`, then launch a
 * headless Chromium browser against it.  Navigates to the root, clicks
 * visible buttons and fills visible inputs, collects console errors and page
 * errors, then closes both the browser and the HTTP server.
 *
 * The `onEvent` callback is invoked for each step so callers can stream
 * `qa_step` events to the frontend while the EventSource is still open.
 *
 * Returns `{ passed, errors, stepsRun }`.  If no index.html is found the
 * function returns an instant pass so non-HTML projects are silently skipped.
 */
export async function runHeadlessQA(
  projectFiles: FileSnapshotEntry[],
  onEvent: (type: string, message: string) => void,
  signal?: AbortSignal,
): Promise<QAResult> {
  const indexFile = projectFiles.find((f) => f.path === "index.html");
  if (!indexFile) {
    logger.info("headless-qa: no index.html — skipping");
    return { passed: true, errors: [], stepsRun: 0 };
  }

  const port = await findFreePort();

  const fileMap = new Map<string, FileSnapshotEntry>();
  for (const f of projectFiles) {
    fileMap.set(f.path, f);
  }

  const server = http.createServer((req, res) => {
    let urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    if (urlPath === "/" || urlPath === "") urlPath = "index.html";
    else urlPath = urlPath.replace(/^\/+/, "");

    const file = fileMap.get(urlPath);
    if (file) {
      res.setHeader("Content-Type", file.mimeType || "text/plain");
      res.setHeader("Cache-Control", "no-cache");
      res.end(file.content);
    } else {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Cache-Control", "no-cache");
      res.end(indexFile.content);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const errors: string[] = [];
  let stepsRun = 0;
  let browser: import("playwright").Browser | null = null;

  // Wire abort signal to close the browser immediately when the caller aborts.
  const abortHandler = async (): Promise<void> => {
    try {
      if (browser) await browser.close();
    } catch {
      // best-effort on abort
    }
  };
  signal?.addEventListener("abort", () => void abortHandler());

  try {
    if (signal?.aborted) throw new Error("QA aborted before start");

    onEvent("qa_step", "Launching QA browser…");
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (
          !text.includes("favicon.ico") &&
          !text.includes("net::ERR_") &&
          !text.includes("Failed to load resource")
        ) {
          errors.push(`Console: ${text.slice(0, 200)}`);
        }
      }
    });
    page.on("pageerror", (err) => {
      errors.push(`JS error: ${err.message.slice(0, 200)}`);
    });

    if (signal?.aborted) throw new Error("QA aborted");

    onEvent("qa_step", "Navigating to app…");
    stepsRun++;
    try {
      await page.goto(`http://127.0.0.1:${port}/`, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
    } catch (navErr) {
      errors.push(`Navigation error: ${(navErr as Error).message.slice(0, 120)}`);
    }

    if (signal?.aborted) throw new Error("QA aborted");

    onEvent("qa_step", "Clicking primary buttons…");
    stepsRun++;
    try {
      const buttons = page.locator("button:visible");
      const count = await buttons.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        if (signal?.aborted) break;
        try {
          await buttons.nth(i).click({ timeout: 2_000, force: true });
        } catch {
          // individual click failures are expected (e.g. disabled, off-screen)
        }
      }
    } catch {
      // locator failures are non-fatal
    }

    if (signal?.aborted) throw new Error("QA aborted");

    onEvent("qa_step", "Following visible links…");
    stepsRun++;
    try {
      const links = page.locator("a[href]:visible");
      const linkCount = await links.count();
      for (let i = 0; i < Math.min(linkCount, 5); i++) {
        if (signal?.aborted) break;
        try {
          const href = await links.nth(i).getAttribute("href");
          // Only click same-page anchors or relative paths to avoid navigation away
          if (href && (href.startsWith("#") || href.startsWith("./") || href === "/")) {
            await links.nth(i).click({ timeout: 2_000, force: true });
          }
        } catch {
          // non-fatal
        }
      }
    } catch {
      // locator failures are non-fatal
    }

    if (signal?.aborted) throw new Error("QA aborted");

    onEvent("qa_step", "Testing form inputs…");
    stepsRun++;
    try {
      const inputs = page.locator("input:visible, textarea:visible");
      const inputCount = await inputs.count();
      for (let i = 0; i < Math.min(inputCount, 3); i++) {
        if (signal?.aborted) break;
        try {
          await inputs.nth(i).fill("test", { timeout: 2_000 });
        } catch {
          // non-fatal
        }
      }
    } catch {
      // non-fatal
    }

    onEvent("qa_step", "Checking for console errors…");
    stepsRun++;

    await browser.close();
    browser = null;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!msg.startsWith("QA aborted")) {
      errors.push(`QA runner error: ${msg.slice(0, 200)}`);
    }
    logger.warn({ err }, "headless-qa: runner error (non-fatal)");
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore close error
      }
      browser = null;
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { passed: errors.length === 0, errors, stepsRun };
}
