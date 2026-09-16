import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import ts from "typescript";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPreviewIframeSandbox } from "@/lib/preview-access-ui";
import { webContainerPageUrl } from "./page-map-card-model";
import { PreviewDeviceFrame } from "./preview-device-frame";

afterEach(cleanup);
const source = ts.createSourceFile(
  "preview-tab.tsx",
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "preview-tab.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let renderer: ts.Expression | undefined;
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "renderIframe")
    renderer = node.initializer;
  ts.forEachChild(node, visit);
}
visit(source);
if (!renderer) throw new Error("Actual PreviewTab iframe renderer missing");
const code = ts.transpileModule("const renderPreview = " + renderer.getText(source) + ";", {
  fileName: "preview-renderer.tsx",
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.React,
  },
}).outputText;

function actualFrame(device: string, webContainerLive: boolean, revision = 7) {
  const context = {
    React,
    agenticPreviewUnavailable: false,
    previewAuthorizationStatus: null,
    webContainerLive,
    serverPreviewLive: !webContainerLive,
    wc: { previewUrl: "https://runtime.example/" },
    requestedPath: "/notes/new",
    currentPath: "/notes/new",
    previewSrc: "/api/projects/901/preview/notes/new?t=" + revision,
    device,
    iframeKey: revision,
    iframeRef: { current: null },
    handleIframeLoad: vi.fn(),
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
    getPreviewIframeSandbox,
    webContainerPageUrl,
  };
  return new Function(...Object.keys(context), code + "\nreturn renderPreview;")(
    ...Object.values(context),
  )("h-full") as React.ReactElement;
}

describe("the actual preview document survives viewport changes", () => {
  it.each([false, true])(
    "retains iframe identity and unsaved form content, WebContainer=%s",
    (webContainerLive) => {
      function frame(
        device: "desktop" | "tablet" | "mobile",
        platform: "web" | "ios" | "android" = "web",
      ) {
        return (
          <PreviewDeviceFrame
            device={device}
            platform={platform}
            projectName="Test app"
            path="/notes/new"
            nativeSimulation={platform !== "web"}
          >
            {actualFrame(device, webContainerLive)}
          </PreviewDeviceFrame>
        );
      }
      const view = render(frame("desktop"));
      const iframe = screen.getByTitle("App preview") as HTMLIFrameElement;
      const document = iframe.contentDocument!;
      // JSDOM does not load this external src. Model its initial document explicitly.
      document.replaceChildren(document.createElement("html"));
      document.documentElement.appendChild(document.createElement("body"));
      const input = document.createElement("input");
      input.value = "Synthetic unsaved input";
      document.body.appendChild(input);
      const src = iframe.getAttribute("src");
      const sandbox = iframe.getAttribute("sandbox");
      for (const device of ["tablet", "mobile", "desktop"] as const) {
        view.rerender(frame(device));
        expect(screen.getByTitle("App preview")).toBe(iframe);
        expect(iframe.contentDocument).toBe(document);
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe("Synthetic unsaved input");
        expect(iframe.getAttribute("src")).toBe(src);
        expect(iframe.getAttribute("sandbox")).toBe(sandbox);
      }
      view.rerender(frame("mobile", "ios"));
      view.rerender(frame("mobile", "android"));
      expect(screen.getByTitle("App preview")).toBe(iframe);
      expect(input.isConnected).toBe(true);
    },
  );

  it("shows the preview address alongside the current app path", () => {
    render(
      <PreviewDeviceFrame
        device="desktop"
        platform="web"
        projectName="Test app"
        path="/notes/new"
        address="preview.example"
        nativeSimulation={false}
      >
        <div>Preview contents</div>
      </PreviewDeviceFrame>,
    );
    expect(screen.getByText("preview.example /notes/new").getAttribute("title")).toBe(
      "preview.example /notes/new",
    );
  });
  it("still replaces the document for an explicit refresh revision", () => {
    function frame(revision: number) {
      return (
        <PreviewDeviceFrame
          device="desktop"
          platform="web"
          projectName="Test app"
          path="/notes/new"
          nativeSimulation={false}
        >
          {actualFrame("desktop", false, revision)}
        </PreviewDeviceFrame>
      );
    }
    const view = render(frame(1));
    const before = screen.getByTitle("App preview");
    view.rerender(frame(2));
    expect(screen.getByTitle("App preview")).not.toBe(before);
    expect(screen.getByTitle("App preview").getAttribute("src")).toContain("t=2");
  });

  it("uses one shared frame in PreviewTab rather than device-specific document branches", () => {
    let frames = 0;
    function count(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "PreviewDeviceFrame")
        frames++;
      ts.forEachChild(node, count);
    }
    count(source);
    expect(frames).toBe(1);
    expect(source.text).not.toMatch(/device === "desktop" \? \(/);
  });
});
