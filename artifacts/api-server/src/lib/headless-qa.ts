import http from "node:http";
import net from "node:net";
import type { FileSnapshotEntry } from "@workspace/db";
import { logger } from "./logger";

export interface QAResult {
  passed: boolean;
  errors: string[];
  stepsRun: number;
}

export type QAStepStatus = "running" | "passed" | "warning" | "failed";

export type QAScreenshotAttachment = {
  tool: "take_screenshot";
  mimeType: "image/jpeg";
  base64: string;
  bytes: number;
  label: string;
};

export type QAStepEventData = {
  kind: "qa_tape_step";
  phase: "launch" | "navigation" | "interaction" | "input" | "console" | "repair";
  status: QAStepStatus;
  screenshot?: QAScreenshotAttachment;
};

export type QAEventCallback = (
  type: string,
  message: string,
  data?: QAStepEventData,
) => void | Promise<void>;

const QA_INPUT_VALUE = "buy milk";
const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_BYTES = 160 * 1024;
const MAX_TOTAL_SCREENSHOT_BYTES = 384 * 1024;

type ScreenshotBudget = {
  count: number;
  remainingBytes: number;
};

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function cleanLabel(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

async function readableControlLabel(
  locator: import("playwright").Locator,
  fallback: string,
): Promise<string> {
  const candidates = await Promise.all([
    locator.getAttribute("aria-label").catch(() => null),
    locator.getAttribute("placeholder").catch(() => null),
    locator.getAttribute("title").catch(() => null),
    locator.getAttribute("name").catch(() => null),
    locator.textContent().catch(() => null),
  ]);
  return candidates.map(cleanLabel).find(Boolean) ?? fallback;
}

async function captureKeyStep(
  page: import("playwright").Page,
  label: string,
  budget: ScreenshotBudget,
): Promise<QAScreenshotAttachment | undefined> {
  if (budget.count >= MAX_SCREENSHOTS || budget.remainingBytes <= 0) return undefined;
  try {
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 45,
      fullPage: false,
      animations: "disabled",
    });
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES || buffer.byteLength > budget.remainingBytes) {
      return undefined;
    }
    budget.count += 1;
    budget.remainingBytes -= buffer.byteLength;
    return {
      tool: "take_screenshot",
      mimeType: "image/jpeg",
      base64: buffer.toString("base64"),
      bytes: buffer.byteLength,
      label,
    };
  } catch {
    return undefined;
  }
}

/**
 * Spin up an in-process HTTP server serving `projectFiles`, then launch a
 * headless Chromium browser against it. The same `qa_step` stream used by the
 * existing UI receives a human-readable action tape and optional, tightly
 * bounded take_screenshot attachments for key frames.
 */
export async function runHeadlessQA(
  projectFiles: FileSnapshotEntry[],
  onEvent: QAEventCallback,
  signal?: AbortSignal,
): Promise<QAResult> {
  const indexFile = projectFiles.find((file) => file.path === "index.html");
  if (!indexFile) {
    logger.info("headless-qa: no index.html - skipping");
    return { passed: true, errors: [], stepsRun: 0 };
  }

  const port = await findFreePort();
  const fileMap = new Map(projectFiles.map((file) => [file.path, file]));
  const server = http.createServer((req, res) => {
    let urlPath = (req.url ?? "/").split("?")[0] ?? "/";
    if (urlPath === "/" || urlPath === "") urlPath = "index.html";
    else urlPath = urlPath.replace(/^\/+/, "");

    const file = fileMap.get(urlPath);
    res.setHeader("Cache-Control", "no-cache");
    if (file) {
      res.setHeader("Content-Type", file.mimeType || "text/plain");
      res.end(file.content);
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(indexFile.content);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const errors: string[] = [];
  const emittedErrors = new Set<string>();
  const screenshotBudget: ScreenshotBudget = {
    count: 0,
    remainingBytes: MAX_TOTAL_SCREENSHOT_BYTES,
  };
  let stepsRun = 0;
  let browser: import("playwright").Browser | null = null;
  let page: import("playwright").Page | null = null;

  const emitStep = async (
    message: string,
    phase: QAStepEventData["phase"],
    status: QAStepStatus,
    screenshot?: QAScreenshotAttachment,
  ): Promise<void> => {
    await onEvent("qa_step", message, {
      kind: "qa_tape_step",
      phase,
      status,
      ...(screenshot ? { screenshot } : {}),
    });
  };

  const recordError = async (
    message: string,
    phase: QAStepEventData["phase"],
    withScreenshot = false,
  ): Promise<void> => {
    const normalized = message.slice(0, 240);
    if (!errors.includes(normalized)) errors.push(normalized);
    if (emittedErrors.has(normalized)) return;
    emittedErrors.add(normalized);
    const screenshot =
      withScreenshot && page ? await captureKeyStep(page, normalized, screenshotBudget) : undefined;
    await emitStep(`Error: ${normalized}`, phase, "failed", screenshot);
  };

  const abortHandler = (): void => {
    void browser?.close().catch(() => {});
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    if (signal?.aborted) throw new Error("QA aborted before start");

    await emitStep("Starting the QA browser", "launch", "running");
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 1100, height: 700 },
    });
    page = await context.newPage();

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (
        text.includes("favicon.ico") ||
        text.includes("net::ERR_") ||
        text.includes("Failed to load resource")
      ) {
        return;
      }
      const error = `Console: ${text.slice(0, 200)}`;
      if (!errors.includes(error)) errors.push(error);
    });
    page.on("pageerror", (error) => {
      const normalized = `JS error: ${error.message.slice(0, 200)}`;
      if (!errors.includes(normalized)) errors.push(normalized);
    });

    await emitStep("Opening the app", "navigation", "running");
    stepsRun += 1;
    try {
      await page.goto(`http://127.0.0.1:${port}/`, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      const screenshot = await captureKeyStep(page, "App opened", screenshotBudget);
      await emitStep("Opened the app", "navigation", "passed", screenshot);
    } catch (error) {
      await recordError(
        `Navigation failed: ${(error as Error).message.slice(0, 160)}`,
        "navigation",
        true,
      );
    }

    if (signal?.aborted) throw new Error("QA aborted");

    const buttons = page.locator("button:visible");
    const buttonCount = await buttons.count().catch(() => 0);
    for (let index = 0; index < Math.min(buttonCount, 5); index += 1) {
      if (signal?.aborted) break;
      const button = buttons.nth(index);
      const label = await readableControlLabel(button, `button ${index + 1}`);
      if (await button.isDisabled().catch(() => false)) {
        await emitStep(`Skipped disabled '${label}'`, "interaction", "warning");
        continue;
      }
      try {
        await button.click({ timeout: 2_000, force: true });
        stepsRun += 1;
        const screenshot =
          screenshotBudget.count < 2
            ? await captureKeyStep(page, `Clicked ${label}`, screenshotBudget)
            : undefined;
        await emitStep(`Clicked '${label}'`, "interaction", "passed", screenshot);
      } catch (error) {
        await recordError(
          `Could not click '${label}': ${(error as Error).message.slice(0, 120)}`,
          "interaction",
          true,
        );
      }
    }

    if (signal?.aborted) throw new Error("QA aborted");

    const links = page.locator("a[href]:visible");
    const linkCount = await links.count().catch(() => 0);
    for (let index = 0; index < Math.min(linkCount, 5); index += 1) {
      if (signal?.aborted) break;
      const link = links.nth(index);
      const href = await link.getAttribute("href").catch(() => null);
      if (!href || (!href.startsWith("#") && !href.startsWith("./") && href !== "/")) {
        continue;
      }
      const label = await readableControlLabel(link, href);
      try {
        await link.click({ timeout: 2_000, force: true });
        stepsRun += 1;
        await emitStep(`Followed '${label}'`, "interaction", "passed");
      } catch (error) {
        await recordError(
          `Could not follow '${label}': ${(error as Error).message.slice(0, 120)}`,
          "interaction",
        );
      }
    }

    if (signal?.aborted) throw new Error("QA aborted");

    const inputs = page.locator(
      "input:visible:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=submit]), textarea:visible",
    );
    const inputCount = await inputs.count().catch(() => 0);
    for (let index = 0; index < Math.min(inputCount, 3); index += 1) {
      if (signal?.aborted) break;
      const input = inputs.nth(index);
      const label = await readableControlLabel(input, `input ${index + 1}`);
      try {
        await input.fill(QA_INPUT_VALUE, { timeout: 2_000 });
        stepsRun += 1;
        const screenshot =
          screenshotBudget.count < MAX_SCREENSHOTS
            ? await captureKeyStep(page, `Typed into ${label}`, screenshotBudget)
            : undefined;
        await emitStep(`Typed '${QA_INPUT_VALUE}' into '${label}'`, "input", "passed", screenshot);
      } catch (error) {
        await recordError(
          `Could not type into '${label}': ${(error as Error).message.slice(0, 120)}`,
          "input",
        );
      }
    }

    await emitStep("Checking the browser console", "console", "running");
    await page.waitForTimeout(150);
    stepsRun += 1;
    if (errors.length === 0) {
      await emitStep("No browser errors found", "console", "passed");
    } else {
      for (const error of [...errors]) {
        await recordError(error, "console", true);
      }
    }

    await browser.close();
    browser = null;
    page = null;
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (!message.startsWith("QA aborted")) {
      await recordError(`QA runner failed: ${message.slice(0, 200)}`, "console");
    }
    logger.warn({ err: error }, "headless-qa: runner error (non-fatal)");
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { passed: errors.length === 0, errors, stepsRun };
}
