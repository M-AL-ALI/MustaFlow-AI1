import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/pages/projects/components/preview-tab.tsx"),
  "utf8",
);

describe("visual edit session UI contract", () => {
  it("opens one server session and binds every source change to it", () => {
    expect(source).toContain("/visual-edit/sessions`");
    expect(source).toContain("sessionId: veSessionId");
    expect(source).toContain("Visual editing is still starting");
  });

  it("offers immediate undo and closes into one restorable version", () => {
    expect(source).toContain("/visual-edit/sessions/${veSessionId}/undo");
    expect(source).toContain("/visual-edit/sessions/${closingSessionId}/close");
    expect(source).toContain("Saved as restorable version #");
  });

  it("keeps unsafe source mapping on the conversational refusal path", () => {
    expect(source).toContain("json.suggestedPrompt");
    expect(source).toContain("setEditMode(false)");
  });
});
