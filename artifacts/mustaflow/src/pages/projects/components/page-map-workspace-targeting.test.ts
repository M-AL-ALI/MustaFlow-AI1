// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as React from "react";
import { getPreviewIframeSandbox, hasServerPreviewAccess } from "@/lib/preview-access-ui";
import { webContainerPageUrl } from "./page-map-card-model";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual workspace callbacks without mounting the workspace or
// booting providers. Only the PageMapTab JSX callback expressions are evaluated.
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const workspace = ts.createSourceFile(
  "workspace.tsx",
  readFileSync(resolve(sourceDirectory, "../[id].tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function callbackSource(name: string): string {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(workspace) === "PageMapTab") {
      for (const prop of node.attributes.properties) {
        if (
          ts.isJsxAttribute(prop) &&
          prop.name.getText(workspace) === name &&
          prop.initializer &&
          ts.isJsxExpression(prop.initializer)
        )
          expression = prop.initializer.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(workspace);
  if (!expression) throw new Error(`Missing PageMapTab callback: ${name}`);
  return expression.getText(workspace);
}

function callback(name: string, context: Record<string, unknown>): (value?: string) => void {
  const code = ts.transpileModule(`const callback = ${callbackSource(name)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(context), code + "\nreturn callback;")(
    ...Object.values(context),
  );
}

describe("Page Map workspace embedding eligibility", () => {
  function available(overrides: Record<string, unknown> = {}) {
    const lifecycle = { projectId: 901 };
    const context = {
      project: { id: 901 },
      projectId: 901,
      containerLifecycle: lifecycle,
      containerSeededLifecycleRef: { current: lifecycle },
      hasServerPreviewAccess,
      previewAccess: "gateway",
      containerStatus: "running",
      containerStarting: false,
      containerActionPending: null,
      previewRecoveryError: null,
      containerAuthorizationStatus: null,
      ...overrides,
    };
    return new Function(
      ...Object.keys(context),
      "return (" + callbackSource("previewAvailable") + ");",
    )(...Object.values(context));
  }

  it.each(["direct", "gateway"])(
    "permits the current project's ready server access: %s",
    (previewAccess) => {
      expect(available({ previewAccess })).toBe(true);
    },
  );

  it.each([
    ["unknown access", { previewAccess: undefined }],
    ["unavailable access", { previewAccess: "unavailable" }],
    ["stopped runtime", { containerStatus: "stopped" }],
    ["starting runtime", { containerStatus: "starting" }],
    ["hibernated runtime", { containerStatus: "hibernated" }],
    ["failed runtime", { containerStatus: "error" }],
    ["startup pending", { containerStarting: true }],
    ["start mutation", { containerActionPending: "start" }],
    ["stop mutation", { containerActionPending: "stop" }],
    ["recovery issue", { previewRecoveryError: { code: "preview_rebuild_failed" } }],
    ["authentication failure", { containerAuthorizationStatus: 401 }],
    ["authorization failure", { containerAuthorizationStatus: 403 }],
    ["different project", { project: { id: 902 } }],
    ["unseeded lifecycle", { containerSeededLifecycleRef: { current: null } }],
    ["different lifecycle", { containerSeededLifecycleRef: { current: { projectId: 901 } } }],
  ])("does not embed when %s", (_name, overrides) => {
    expect(available(overrides as Record<string, unknown>)).toBe(false);
  });
});

describe("Page Map workspace targeting", () => {
  it("selects the exact project file rather than retaining the previous editor target", () => {
    const setSelectedCodeFileId = vi.fn();
    const setSelectedCodeFileLine = vi.fn();
    const setActiveTab = vi.fn();
    const open = callback("onSwitchToCode", {
      files: [
        { id: 11, path: "src/pages/Account.tsx" },
        { id: 12, path: "src/admin/Account.tsx" },
      ],
      setSelectedCodeFileId,
      setSelectedCodeFileLine,
      setActiveTab,
    });
    open("src/admin/Account.tsx");
    expect(setSelectedCodeFileId).toHaveBeenCalledWith(12);
    expect(setSelectedCodeFileLine).toHaveBeenCalledWith(null);
    expect(setActiveTab).toHaveBeenCalledWith("code");
    vi.clearAllMocks();
    open("another-project/Account.tsx");
    expect(setSelectedCodeFileId).not.toHaveBeenCalled();
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it("prepares editable composer text without sending or replacing an existing draft", () => {
    let prompt = "Keep my existing instructions.";
    const input = { value: prompt, focus: vi.fn(), setSelectionRange: vi.fn() };
    const send = vi.fn();
    const setChatDrawerOpen = vi.fn();
    const switchLeftPanel = vi.fn();
    const setPrompt = vi.fn((update: (previous: string) => string) => {
      prompt = update(prompt);
      input.value = prompt;
    });
    const prepare = callback("onSwitchToChat", {
      send,
      setPrompt,
      switchLeftPanel,
      setChatDrawerOpen,
      setShowChatHistory: vi.fn(),
      isMobileLayout: true,
      requestAnimationFrame: (work: () => void) => work(),
      document: { querySelector: () => input },
    });
    const target = "Selected page: src/admin/Account.tsx\nRequested changes:";
    prepare(target);
    expect(prompt).toBe("Keep my existing instructions.\n\n" + target);
    expect(send).not.toHaveBeenCalled();
    expect(switchLeftPanel).toHaveBeenCalledWith("chat");
    expect(setChatDrawerOpen).toHaveBeenCalledWith(true);
    expect(input.focus).toHaveBeenCalled();
    expect(input.setSelectionRange).toHaveBeenCalledWith(prompt.length, prompt.length);
    prepare(target);
    expect(prompt).toBe("Keep my existing instructions.\n\n" + target);
    expect(send).not.toHaveBeenCalled();
  });

  it("places a targeted request in an empty composer without dispatch", () => {
    let prompt = "";
    const send = vi.fn();
    const prepare = callback("onSwitchToChat", {
      send,
      setPrompt: (update: (previous: string) => string) => {
        prompt = update(prompt);
      },
      switchLeftPanel: vi.fn(),
      setShowChatHistory: vi.fn(),
      setChatDrawerOpen: vi.fn(),
      isMobileLayout: false,
      requestAnimationFrame: (work: () => void) => work(),
      document: { querySelector: () => null },
    });
    prepare("Targeted redesign draft");
    expect(prompt).toBe("Targeted redesign draft");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Page Map route in the actual PreviewTab WebContainer renderer", () => {
  const preview = ts.createSourceFile(
    "preview-tab.tsx",
    readFileSync(resolve(sourceDirectory, "./preview-tab.tsx"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  function frameAt(currentPath: string, requestId: number) {
    let renderer: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText(preview) === "renderIframe")
        renderer = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(preview);
    if (!renderer) throw new Error("PreviewTab renderer not found");
    const code = ts.transpileModule(`const renderPreview = ${renderer.getText(preview)};`, {
      fileName: "preview-renderer.tsx",
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.React,
      },
    }).outputText;
    const context = {
      React,
      agenticPreviewUnavailable: false,
      previewAuthorizationStatus: null,
      webContainerLive: true,
      serverPreviewLive: false,
      wc: { previewUrl: "https://runtime.example/" },
      currentPath,
      previewSrc: "/api/projects/901/preview/",
      device: "desktop",
      navigationRequest: { path: currentPath, requestId },
      iframeKey: 0,
      iframeRef: { current: null },
      handleIframeLoad: vi.fn(),
      cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
      getPreviewIframeSandbox,
      webContainerPageUrl,
    };
    const renderPreview = new Function(...Object.keys(context), code + "\nreturn renderPreview;")(
      ...Object.values(context),
    );
    return renderPreview() as React.ReactElement<React.IframeHTMLAttributes<HTMLIFrameElement>>;
  }

  it("renders the selected concrete route instead of the WebContainer root", () => {
    const frame = frameAt("/account/profile", 101);
    expect(frame.props.src).toBe("https://runtime.example/account/profile");
    expect(frame.props.sandbox).toBe(
      getPreviewIframeSandbox({ serverPreviewLive: false, webContainerLive: true }),
    );
    const another = frameAt("/settings", 102);
    expect(another.props.src).toBe("https://runtime.example/settings");
    expect(another.key).not.toBe(frame.key);
    expect(frameAt("/settings", 103).key).not.toBe(another.key);
  });
});
