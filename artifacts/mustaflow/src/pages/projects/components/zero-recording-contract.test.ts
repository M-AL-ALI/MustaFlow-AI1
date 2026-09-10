import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/zero-agent-panel.tsx"),
  "utf8",
);

function recordingStructure(source: string) {
  const file = ts.createSourceFile(
    "recording.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const printer = ts.createPrinter({ removeComments: true });
  const text = (node: ts.Node) =>
    ts.isStringLiteral(node)
      ? JSON.stringify(node.text)
      : ts.isNumericLiteral(node)
        ? String(Number(node.text))
        : printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, "");
  const calls: { kind: "call" | "construct"; expression: string; args: string[] }[] = [];
  const strings: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      calls.push({
        kind: ts.isNewExpression(node) ? "construct" : "call",
        expression: text(node.expression),
        args: [...(node.arguments ?? [])].map(text),
      });
    }
    if (ts.isStringLiteral(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { calls, strings };
}

const structure = recordingStructure(panel);

describe("Zero recording attachment contract", () => {
  it("captures a bounded eight-second recording plus start and end evidence", () => {
    expect(structure.calls).toEqual(
      expect.arrayContaining([
        {
          kind: "call",
          expression: "navigator.mediaDevices.getDisplayMedia",
          args: ["{video:true,audio:false}"],
        },
        {
          kind: "construct",
          expression: "MediaRecorder",
          args: ["stream", '{mimeType:"video/webm"}'],
        },
        { kind: "call", expression: "setTimeout", args: ["resolve", "8000"] },
        {
          kind: "call",
          expression: "handleFiles",
          args: ["[startFrame,endFrame,recording]", '"recording"', "scope"],
        },
      ]),
    );
    expect(structure.strings).toEqual(
      expect.arrayContaining(["preview-start.png", "preview-end.png"]),
    );
  });

  it("always stops every capture track", () => {
    expect(structure.calls).toContainEqual({
      kind: "call",
      expression: "stream?.getTracks().forEach",
      args: ["(track)=>track.stop()"],
    });
  });

  it("checks executable structure independently of line wrapping and comments", () => {
    const fixture = recordingStructure(`
      // navigator.mediaDevices.getDisplayMedia({ video: false });
      navigator.mediaDevices
        .getDisplayMedia({ video: true, audio: false });
      setTimeout(resolve, 8_000);
    `);
    expect(fixture.calls).toEqual([
      {
        kind: "call",
        expression: "navigator.mediaDevices.getDisplayMedia",
        args: ["{video:true,audio:false}"],
      },
      { kind: "call", expression: "setTimeout", args: ["resolve", "8000"] },
    ]);
  });
});
