import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/zero-agent-panel.tsx"),
  "utf8",
);

describe("Zero recording attachment contract", () => {
  it("captures a bounded eight-second recording plus start and end evidence", () => {
    expect(panel).toContain("navigator.mediaDevices.getDisplayMedia");
    expect(panel).toContain("new MediaRecorder");
    expect(panel).toContain("setTimeout(resolve, 8_000)");
    expect(panel).toContain('handleFiles([startFrame, endFrame, recording], "recording")');
    expect(panel).toContain("preview-start.png");
    expect(panel).toContain("preview-end.png");
  });

  it("always stops every capture track", () => {
    expect(panel).toContain("stream?.getTracks().forEach((track) => track.stop())");
  });
});
