import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute only the actual helper and its production call expression. Importing
// jobs.ts would start its dependency graph; this is not a database or build E2E.
const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("jobs.ts", source, ts.ScriptTarget.Latest, true);
const helpers: ts.FunctionDeclaration[] = [];
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "autoWriteFailureLesson") {
    helpers.push(node);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "autoWriteFailureLesson"
  ) {
    calls.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (helpers.length !== 1 || calls.length !== 1) {
  throw new Error("Expected one failure-lesson helper and one production call");
}
const helper = helpers[0]!;
const productionCall = calls[0]!;
function compileExpression(expression: string): string {
  return ts.transpileModule("(" + expression + ")", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: "jobs.failure-lesson.boundary.ts",
  }).outputText;
}
const helperCode = compileExpression(helper.getText(ast));
const callCode = compileExpression(productionCall.getText(ast));

type FailureLesson = {
  title: string;
  category: string;
  content: string;
  type: string;
  severity: string;
  projectId: number;
  relatedTaskId: number;
  userId?: string;
};

function setup() {
  const writeKnowledge = vi
    .fn<(input: FailureLesson) => Promise<void>>()
    .mockResolvedValue(undefined);
  const autoWriteFailureLesson = runInNewContext(helperCode, { writeKnowledge }) as (
    userPrompt: string,
    errorMessage: string,
    projectId: number,
    taskId: number,
    userId?: string,
  ) => Promise<void>;
  return { writeKnowledge, autoWriteFailureLesson };
}

describe("future failure-lesson task linkage", () => {
  it.each(["owner-61", undefined])(
    "preserves diagnostic fields and binds the executing task with owner %s",
    async (userId) => {
      const subject = setup();
      const prompt = "Full original notebook request ".repeat(6);
      const error = "required-source-check-failed ".repeat(20);
      await subject.autoWriteFailureLesson(prompt, error, 61, 917, userId);
      expect(subject.writeKnowledge).toHaveBeenCalledExactlyOnceWith({
        title: 'Build failed: "' + prompt.slice(0, 60) + '"',
        category: "diagnostic",
        content:
          "Attempt failed with error: " +
          error.slice(0, 300) +
          ". Review the fix suggestions and adjust the approach before retrying.",
        type: "build",
        severity: "error",
        projectId: 61,
        relatedTaskId: 917,
        userId,
      });
    },
  );

  it("keeps explicit task identities despite identical truncated title prefixes", async () => {
    const subject = setup();
    const prefix = "same-prefix-".repeat(6);
    await subject.autoWriteFailureLesson(prefix + "first", "failure one", 61, 917, "owner-61");
    await subject.autoWriteFailureLesson(prefix + "second", "failure two", 61, 918, "owner-61");
    expect(subject.writeKnowledge).toHaveBeenCalledTimes(2);
    const first = subject.writeKnowledge.mock.calls[0]![0];
    const second = subject.writeKnowledge.mock.calls[1]![0];
    expect(first.title).toBe(second.title);
    expect(first.relatedTaskId).toBe(917);
    expect(second.relatedTaskId).toBe(918);
  });

  it("requires taskId and executes the failure-path call with its actual task and owner", async () => {
    expect(helper.parameters.map((parameter) => parameter.name.getText(ast))).toEqual([
      "userPrompt",
      "errorMessage",
      "projectId",
      "taskId",
      "userId",
    ]);
    const taskParameter = helper.parameters[3]!;
    expect(taskParameter.questionToken).toBeUndefined();
    expect(taskParameter.initializer).toBeUndefined();
    expect(taskParameter.type?.kind).toBe(ts.SyntaxKind.NumberKeyword);
    expect(productionCall.arguments.map((argument) => argument.getText(ast))).toEqual([
      "userPrompt",
      "message",
      "projectId",
      "taskId",
      "project.ownerId",
    ]);
    let ancestor: ts.Node | undefined = productionCall.parent;
    while (ancestor && !ts.isCatchClause(ancestor)) ancestor = ancestor.parent;
    expect(ancestor?.kind).toBe(ts.SyntaxKind.CatchClause);

    const subject = setup();
    await runInNewContext(callCode, {
      autoWriteFailureLesson: subject.autoWriteFailureLesson,
      userPrompt: "Build this existing notebook",
      message: "required-source-check-failed",
      projectId: 61,
      taskId: 919,
      project: { ownerId: "owner-61" },
    });
    expect(subject.writeKnowledge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        projectId: 61,
        relatedTaskId: 919,
        userId: "owner-61",
      }),
    );
  });
});
