import * as nodePath from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

// Exercise the actual component effect without mounting unrelated editor tools.
const source = ts.createSourceFile(
  "preview-tab.tsx",
  readFileSync(
    nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "./preview-tab.tsx"),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const component = source.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "PreviewTab",
);
const effects = component?.body?.statements.filter(
  (node) =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(source) === "useEffect" &&
    node.getText(source).includes("/preview/?t=${Date.now()}"),
);
if (effects?.length !== 1) throw new Error("Expected exactly one authenticated preview probe.");
const effectCode = ts.transpileModule(effects[0]!.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type ProbeResponse = {
  status: number;
  type?: string;
  headers: { get: (name: string) => string | null };
};

function response(status: number, state: string | null = null): ProbeResponse {
  return {
    status,
    headers: { get: (name) => (name === "X-MustaFlow-Preview-State" ? state : null) },
  };
}

function mountProbe(pending: Promise<ProbeResponse>, serverPreviewLive = true) {
  const authFetch = vi.fn().mockReturnValue(pending);
  const setPreviewIssue = vi.fn();
  const setPreviewAuthorizationStatus = vi.fn();
  let cleanup: (() => void) | undefined;
  const context = {
    useEffect: (effect: () => (() => void) | undefined) => {
      cleanup = effect();
    },
    authFetch,
    project: { id: 61 },
    serverPreviewLive,
    iframeKey: 0,
    setPreviewIssue,
    setPreviewAuthorizationStatus,
    isPreviewAuthorizationStatus: (status: number) => status === 401 || status === 403,
  };
  new Function(...Object.keys(context), effectCode)(...Object.values(context));
  return { authFetch, setPreviewIssue, setPreviewAuthorizationStatus, unmount: () => cleanup?.() };
}

describe("authenticated preview handoff probe", () => {
  it("does not follow or redeem the iframe's cross-origin launch redirect", async () => {
    const subject = mountProbe(Promise.resolve({ ...response(0), type: "opaqueredirect" }));
    await Promise.resolve();
    expect(subject.authFetch).toHaveBeenCalledOnce();
    expect(subject.authFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/projects\/61\/preview\/\?t=\d+$/),
      { method: "GET", credentials: "include", redirect: "manual" },
    );
    expect(subject.setPreviewAuthorizationStatus).toHaveBeenCalledWith(null);
    expect(subject.setPreviewIssue).toHaveBeenCalledWith(null);
  });

  it.each([401, 403])("retains same-origin access denial %s", async (status) => {
    const subject = mountProbe(Promise.resolve(response(status, "proxy-unavailable")));
    await Promise.resolve();
    expect(subject.setPreviewAuthorizationStatus).toHaveBeenCalledWith(status);
    expect(subject.setPreviewIssue).toHaveBeenCalledWith(null);
  });

  it.each(["proxy-unavailable", "server-unreachable", "container-error"])(
    "retains the authenticated %s diagnostic",
    async (state) => {
      const subject = mountProbe(Promise.resolve(response(502, state)));
      await Promise.resolve();
      expect(subject.setPreviewAuthorizationStatus).toHaveBeenCalledWith(null);
      expect(subject.setPreviewIssue).toHaveBeenCalledWith(state);
    },
  );

  it("keeps ordinary successful same-origin responses compatible", async () => {
    const subject = mountProbe(Promise.resolve(response(200)));
    await Promise.resolve();
    expect(subject.setPreviewIssue).toHaveBeenCalledWith(null);
    expect(subject.setPreviewAuthorizationStatus).toHaveBeenCalledWith(null);
  });

  it("preserves the existing non-mutating network-failure behavior", async () => {
    const subject = mountProbe(Promise.reject(new Error("offline")));
    await Promise.resolve();
    expect(subject.setPreviewIssue).toHaveBeenCalledWith(null);
    expect(subject.setPreviewAuthorizationStatus).not.toHaveBeenCalled();
    expect(subject.authFetch).toHaveBeenCalledOnce();
  });

  it("does not apply a stale denial after the preview effect is disposed", async () => {
    let complete!: (result: ProbeResponse) => void;
    const subject = mountProbe(new Promise((resolve) => (complete = resolve)));
    subject.unmount();
    complete(response(403));
    await Promise.resolve();
    expect(subject.setPreviewAuthorizationStatus).not.toHaveBeenCalled();
    expect(subject.setPreviewIssue).not.toHaveBeenCalled();
  });

  it("does not request an unavailable server preview", () => {
    const subject = mountProbe(Promise.resolve(response(200)), false);
    expect(subject.authFetch).not.toHaveBeenCalled();
    expect(subject.setPreviewIssue).toHaveBeenCalledWith(null);
    expect(subject.setPreviewAuthorizationStatus).toHaveBeenCalledWith(null);
  });
});
