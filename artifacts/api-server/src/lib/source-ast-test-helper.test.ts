import { describe, expect, it } from "vitest";
import {
  extractCatchClauseByParameter,
  extractCallContainingIdentifier,
  extractInnermostIfContainingIdentifier,
  extractIfStatementByCondition,
  extractImportDeclaration,
  extractInnermostIfContainingText,
  extractInnermostJsxContainingText,
  extractJsxElementByAttribute,
  extractNamedDeclaration,
  extractNamedFunction,
  extractNamedInterface,
  extractNamedMethod,
  extractObjectLiteralByStringProperty,
  extractNearestBlockContainingDeclaration,
  extractNearestBlockContainingExactDeclaration,
  extractRouteHandler,
  extractSwitchCase,
  extractUniqueJsxElementByName,
  extractTryStatementContainingIdentifier,
} from "./source-ast-test-helper";

describe("source AST test helper", () => {
  it("returns the innermost try containing the unique declaration", () => {
    const source = `
      async function run() {
        try {
          const outerOnly = true;
          try {
            const targetReceipt = await work();
            consume(targetReceipt);
          } catch {}
          settleElsewhere();
        } catch {}
      }
    `;

    const result = extractTryStatementContainingIdentifier(source, "targetReceipt");

    expect(result).toContain("const targetReceipt");
    expect(result).toContain("consume(targetReceipt)");
    expect(result).not.toContain("outerOnly");
    expect(result).not.toContain("settleElsewhere");
  });

  it("returns the nearest block containing the unique declaration", () => {
    const source = `function run() { if (ready) { const receipt = work(); use(receipt); } after(); }`;
    const result = extractNearestBlockContainingDeclaration(source, "receipt");
    expect(result).toContain("use(receipt)");
    expect(result).not.toContain("after()");
  });

  it("disambiguates a containing block by exact initializer", () => {
    const source = `function one() { const value = first(); useFirst(); } function two() { const value = second(); useSecond(); }`;
    const block = extractNearestBlockContainingExactDeclaration(source, "value", "second()");
    expect(block).toContain("useSecond()");
    expect(block).not.toContain("useFirst()");
  });

  it("returns exact named function and declaration nodes", () => {
    const source = `function wanted() { return 1; } function other() { return 2; } const target = () => 3;`;
    expect(extractNamedFunction(source, "wanted")).toContain("return 1");
    expect(extractNamedFunction(source, "wanted")).not.toContain("return 2");
    expect(extractNamedDeclaration(source, "target")).toContain("() => 3");
  });

  it("returns an exact class method", () => {
    const source = `class Example { private async target() { work(); } other() { ignore(); } }`;
    const method = extractNamedMethod(source, "target");
    expect(method).toContain("work()");
    expect(method).not.toContain("ignore()");
  });

  it("returns an exact named interface and switch case", () => {
    const source = `
      interface Example { value: string }
      switch (event.type) {
        case "ready": useReady(); break;
        case "done": useDone(); break;
      }
    `;

    expect(extractNamedInterface(source, "Example")).toContain("value: string");
    expect(extractSwitchCase(source, "ready")).toContain("useReady()");
    expect(extractSwitchCase(source, "ready")).not.toContain("useDone()");
  });

  it("returns exact import, JSX, and object literal nodes", () => {
    const source = `
      import type { Target } from "target-module";
      const options = [{ format: "pdf", value: 1 }, { format: "docx", value: 2 }];
      const view = <TargetCard label="One" />;
    `;
    expect(extractImportDeclaration(source, "target-module", "tsx")).toContain("Target");
    expect(extractUniqueJsxElementByName(source, "TargetCard")).toContain('label="One"');
    expect(extractObjectLiteralByStringProperty(source, "format", "pdf", "tsx")).toContain(
      "value: 1",
    );
  });

  it("returns the innermost JSX node containing exact code text", () => {
    const source = `<View><Card>{target ? <Text>Retry</Text> : null}</Card><Other /></View>`;
    const node = extractInnermostJsxContainingText(source, "target ?");
    expect(node).toContain("Retry");
    expect(node).not.toContain("Other");
  });

  it("returns the shared body for stacked switch labels", () => {
    const source = `switch (event.type) { case "stopped": case "cleared": reset(); break; case "done": finish(); }`;
    const stopped = extractSwitchCase(source, "stopped");
    expect(stopped).toContain('case "cleared"');
    expect(stopped).toContain("reset()");
    expect(stopped).not.toContain("finish()");
  });

  it("returns the innermost if containing a uniquely named declaration", () => {
    const source = `
      if (outer) {
        const outside = 1;
        if (inner) {
          const target = 2;
          use(target);
        }
      }
    `;

    const branch = extractInnermostIfContainingIdentifier(source, "target");
    expect(branch).toContain("use(target)");
    expect(branch).not.toContain("outside");
  });

  it("returns an exact if statement by its condition", () => {
    const source = `if (target && ready) { useTarget(); } if (other) { useOther(); }`;
    const branch = extractIfStatementByCondition(source, "target && ready");
    expect(branch).toContain("useTarget()");
    expect(branch).not.toContain("useOther()");
  });

  it("returns the innermost if containing exact code text", () => {
    const source = `if (outer) { if (target) { execute(targetCall); } after(); }`;
    const branch = extractInnermostIfContainingText(source, "execute(targetCall)");
    expect(branch).toContain("if (target)");
    expect(branch).not.toContain("after()");
  });

  it("returns an exact catch clause by its parameter", () => {
    const source = `try { work(); } catch (targetError) { contain(targetError); } try { other(); } catch (otherError) { ignore(otherError); }`;
    const clause = extractCatchClauseByParameter(source, "targetError");
    expect(clause).toContain("contain(targetError)");
    expect(clause).not.toContain("ignore(otherError)");
  });

  it("returns only the exact route handler", () => {
    const source = `router.get("/other", (_q, r) => r.send("other")); router.post("/target", auth, (_q, r) => r.send("target"));`;
    const result = extractRouteHandler(source, "post", "/target");
    expect(result).toContain('r.send("target")');
    expect(result).not.toContain("other");
  });

  it("returns exact call and JSX nodes selected by syntax identity", () => {
    const source = `
      useEffect(() => consume(targetSignal), [targetSignal]);
      useEffect(() => consume(otherSignal), [otherSignal]);
      const view = <SectionCard title="Target"><Button label="Go" /></SectionCard>;
    `;
    expect(
      extractCallContainingIdentifier(source, "useEffect", "targetSignal", "tsx"),
    ).not.toContain("otherSignal");
    const card = extractJsxElementByAttribute(source, "SectionCard", "title", "Target");
    expect(card).toContain('label="Go"');
  });
});
