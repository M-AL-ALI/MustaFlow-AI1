import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Phase 5 — Multi-File Intelligence: "working from" chip wiring (web + mobile).
 *
 * The server returns `usedFiles` (names + roles only, never refs or bytes) on
 * multi-file turns. These source-string tests pin the client wiring:
 *
 *   1. The web hook keeps `usedFiles` in the response contract, maps it onto
 *      assistant messages, and round-trips it through persistence.
 *   2. The main panel renders the chip for ALL assistant messages (multi-file
 *      workflows work for anonymous sessions too — no sign-in gate).
 *   3. The chip and the mobile indicator label every planner role.
 *   4. Mobile mirrors the same contract and response spread (web parity).
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) => readFileSync(resolve(here, relativePath), "utf8");

const hookSource = read("../../../hooks/use-ora-chat.ts");
const panelSource = read("../../ora-panel.tsx");
const chipSource = read("../ora-used-files-chip.tsx");

const mobileTypesSource = read("../../../../../ora-mobile/lib/types.ts");
const mobileChatSource = read("../../../../../ora-mobile/app/(home)/index.tsx");
const mobileExtrasSource = read("../../../../../ora-mobile/components/ora/MessageExtras.tsx");

const ALL_ROLES = [
  "source_data",
  "target_document",
  "target_presentation",
  "comparison_a",
  "comparison_b",
  "merge_input",
  "reference",
];

describe("Phase 5 usedFiles — web hook contract", () => {
  it("keeps usedFiles in the message shape and chat response contract", () => {
    expect(hookSource).toContain("usedFiles?: OraUsedFile[];");
    expect(hookSource).toMatch(
      /import type \{[\s\S]*?OraUsedFile,[\s\S]*?\} from "@workspace\/ora-contracts"/,
    );
  });

  it("maps the backend usedFiles payload onto assistant messages", () => {
    expect(hookSource).toContain(
      "...(d.usedFiles && d.usedFiles.length > 0 ? { usedFiles: d.usedFiles } : {})",
    );
  });

  it("round-trips usedFiles through conversation persistence", () => {
    expect(hookSource).toContain(
      "...(m.usedFiles && m.usedFiles.length > 0 ? { usedFiles: m.usedFiles } : {})",
    );
  });
});

describe("Phase 5 usedFiles — web panel rendering", () => {
  it("imports and renders the chip beneath assistant replies", () => {
    expect(panelSource).toContain(
      'import { OraUsedFilesChip } from "@/components/ora/ora-used-files-chip";',
    );
    expect(panelSource).toMatch(
      /Array\.isArray\(msg\.usedFiles\)\s*&&[\s\S]{0,80}<OraUsedFilesChip files=\{msg\.usedFiles\}/,
    );
  });

  it("does NOT gate the chip on sign-in (anonymous multi-file turns show it too)", () => {
    const block = panelSource.match(
      /\{msg\.role === "assistant" &&[^{}]*Array\.isArray\(msg\.usedFiles\)[\s\S]*?OraUsedFilesChip[^}]*\}/,
    );
    expect(block).not.toBeNull();
    expect(block![0]).not.toContain("isSignedIn");
  });

  it("labels every planner role in the expanded chip", () => {
    for (const role of ALL_ROLES) {
      expect(chipSource).toContain(`${role}:`);
    }
    expect(chipSource).toContain("ROLE_LABELS[f.role] ?? f.role");
    expect(chipSource).toContain("`Used ${files.length} files`");
  });
});

describe("Phase 5 usedFiles — mobile parity", () => {
  it("mirrors the contract on the mobile message/response types", () => {
    expect(mobileTypesSource).toContain("usedFiles?: OraUsedFile[];");
    expect(mobileTypesSource).toMatch(/OraUsedFile,[\s\S]*?\} from "@workspace\/ora-contracts"/);
  });

  it("spreads usedFiles from the chat response onto the assistant message", () => {
    expect(mobileChatSource).toContain(
      "...(res.usedFiles && res.usedFiles.length > 0 ? { usedFiles: res.usedFiles } : {})",
    );
  });

  it("renders the indicator with every planner role labeled", () => {
    expect(mobileExtrasSource).toContain("<OraUsedFilesIndicator message={message} c={c} />");
    expect(mobileExtrasSource).toContain("message.usedFiles ?? []");
    for (const role of ALL_ROLES) {
      expect(mobileExtrasSource).toContain(`${role}: `);
    }
    expect(mobileExtrasSource).toContain("USED_FILE_ROLE_LABELS[f.role] ?? f.role");
  });
});
