import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { createChatCompletion } from "./ai-providers";

vi.mock("@workspace/db", () => ({
  db: {},
  chatMessagesTable: {},
  projectSuggestionsTable: {},
  projectsTable: {},
}));

vi.mock("./ai-providers", () => ({
  createChatCompletion: vi.fn(),
}));

import {
  buildDeterministicFallbackSuggestions,
  buildFailureFixSuggestions,
  generatePostBuildSuggestions,
  postBuildSuggestionOutcome,
  type PostBuildSuggestion,
  type PostBuildSuggestionInput,
  type SuggestionDiagnostic,
  type SuggestionGenerationDependencies,
} from "./post-build-suggestions";

const INPUT: PostBuildSuggestionInput = {
  projectId: 45,
  taskId: 901,
  projectName: "Production-shaped task app",
  projectKind: "web",
  projectFormat: "react-vite",
  userPrompt: "Improve the task list controls",
  assistantSummary: "Updated the existing task list.",
  filePaths: ["src/App.tsx", "src/components/TaskList.tsx"],
  activeIntegrations: "",
};

function completion(
  content: string | null,
  finishReason = "stop",
  outputTokens = 180,
  reasoningTokens = 12,
): ChatCompletion {
  return {
    id: "completion-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: "assistant",
          content,
          refusal: null,
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: outputTokens,
      total_tokens: 100 + outputTokens,
      completion_tokens_details: {
        accepted_prediction_tokens: 0,
        audio_tokens: 0,
        reasoning_tokens: reasoningTokens,
        rejected_prediction_tokens: 0,
      },
      prompt_tokens_details: {
        audio_tokens: 0,
        cached_tokens: 0,
      },
    },
  } as ChatCompletion;
}

function validCompletion(title = "Improve task controls"): ChatCompletion {
  return completion(
    JSON.stringify({
      suggestions: [
        {
          title,
          description: "Make existing task controls easier to use.",
          category: "improvement",
          prompt:
            "Review the existing task controls and make one focused usability improvement supported by the current code.",
        },
      ],
    }),
  );
}

function harness() {
  const createCompletion = vi.fn<typeof createChatCompletion>();
  const loadContext = vi.fn(async () => ({
    pageMap: {
      web: {
        nodes: [
          {
            label: "Task dashboard",
            filePath: "src/App.tsx",
            planned: false,
          },
        ],
      },
    },
    currentPlan: { steps: [{ title: "Polish the task list" }] },
    recentTaskId: INPUT.taskId,
  }));
  const inserted: PostBuildSuggestion[][] = [];
  const insertSuggestions = vi.fn(
    async (_input: PostBuildSuggestionInput, suggestions: PostBuildSuggestion[]) => {
      inserted.push(suggestions);
    },
  );
  const diagnostics: SuggestionDiagnostic[] = [];
  const logDiagnostic = vi.fn((diagnostic: SuggestionDiagnostic) => {
    diagnostics.push(diagnostic);
  });

  const dependencies: SuggestionGenerationDependencies = {
    createCompletion,
    loadContext,
    insertSuggestions,
    logDiagnostic,
  };

  return {
    createCompletion,
    loadContext,
    insertSuggestions,
    diagnostics,
    inserted,
    dependencies,
  };
}

function expectApprovedDiagnosticShape(diagnostic: SuggestionDiagnostic): void {
  expect(Object.keys(diagnostic).sort()).toEqual([
    "failure_category",
    "finish_reason",
    "output_tokens",
    "parsed_count",
    "reasoning_tokens",
  ]);
}

describe("post-build suggestions", () => {
  it("persists valid model suggestions without loading or firing fallbacks", async () => {
    const test = harness();
    test.createCompletion.mockResolvedValue(validCompletion());

    const result = await generatePostBuildSuggestions(INPUT, test.dependencies);

    expect(result).toEqual({ count: 1, source: "model" });
    expect(test.createCompletion).toHaveBeenCalledTimes(1);
    expect(test.loadContext).not.toHaveBeenCalled();
    expect(test.inserted).toHaveLength(1);
    expect(test.inserted[0]?.[0]?.title).toBe("Improve task controls");
    expect(test.createCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5-mini",
        reasoning_effort: "low",
        max_completion_tokens: 4000,
      }),
    );
    expect(test.diagnostics).toHaveLength(1);
    expect(test.diagnostics[0]).toMatchObject({
      finish_reason: "stop",
      reasoning_tokens: 12,
      output_tokens: 180,
      parsed_count: 1,
      failure_category: "none",
    });
    expectApprovedDiagnosticShape(test.diagnostics[0]!);
  });

  it("retries one empty response, then persists honest context-derived fallbacks", async () => {
    const test = harness();
    test.createCompletion.mockResolvedValue(completion(""));

    const result = await generatePostBuildSuggestions(INPUT, test.dependencies);

    expect(result.source).toBe("fallback");
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.count).toBeLessThanOrEqual(3);
    expect(test.createCompletion).toHaveBeenCalledTimes(2);
    expect(test.loadContext).toHaveBeenCalledTimes(1);
    expect(test.inserted[0]?.map((suggestion) => suggestion.title)).toEqual([
      "Review the latest task",
      "Review Task dashboard",
      "Check the saved plan",
    ]);
    for (const diagnostic of test.diagnostics) expectApprovedDiagnosticShape(diagnostic);
  });

  it("retries invalid output once, then uses fallbacks", async () => {
    const test = harness();
    test.createCompletion.mockResolvedValue(completion("{not-json"));

    const result = await generatePostBuildSuggestions(INPUT, test.dependencies);

    expect(result.source).toBe("fallback");
    expect(test.createCompletion).toHaveBeenCalledTimes(2);
    expect(test.diagnostics.map((diagnostic) => diagnostic.failure_category)).toEqual([
      "invalid_json",
      "invalid_json",
      "fallback_used",
    ]);
  });

  it("does not retry a thrown provider call and still persists a fallback", async () => {
    const test = harness();
    test.createCompletion.mockRejectedValue(new Error("provider unavailable"));

    const result = await generatePostBuildSuggestions(INPUT, test.dependencies);

    expect(result.source).toBe("fallback");
    expect(test.createCompletion).toHaveBeenCalledTimes(1);
    expect(test.inserted[0]?.length).toBeGreaterThanOrEqual(1);
    expect(test.diagnostics.map((diagnostic) => diagnostic.failure_category)).toEqual([
      "provider_error",
      "fallback_used",
    ]);
  });

  it("uses the second valid model response without firing fallbacks", async () => {
    const test = harness();
    test.createCompletion
      .mockResolvedValueOnce(completion(JSON.stringify({ suggestions: [] })))
      .mockResolvedValueOnce(validCompletion("Polish existing tasks"));

    const result = await generatePostBuildSuggestions(INPUT, test.dependencies);

    expect(result).toEqual({ count: 1, source: "model" });
    expect(test.createCompletion).toHaveBeenCalledTimes(2);
    expect(test.loadContext).not.toHaveBeenCalled();
    expect(test.inserted).toHaveLength(1);
    expect(test.inserted[0]?.[0]?.title).toBe("Polish existing tasks");
  });

  it("builds no more than three generic fallbacks from real context", () => {
    const suggestions = buildDeterministicFallbackSuggestions({
      pageMap: {
        web: {
          nodes: [
            { label: "Existing dashboard", filePath: "src/App.tsx", planned: false },
            { label: "Future billing", filePath: "", planned: true },
          ],
        },
      },
      currentPlan: { steps: [{ title: "Use the existing dashboard" }] },
      recentTaskId: 901,
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((suggestion) => suggestion.title)).toEqual([
      "Review the latest task",
      "Review Existing dashboard",
      "Check the saved plan",
    ]);
    const serialized = JSON.stringify(suggestions);
    expect(serialized).not.toContain("Future billing");
    expect(serialized).not.toContain("route");
    expect(serialized).not.toContain("successfully built");
  });
});

describe("failed-build recovery stays grounded", () => {
  it.each(["Route Atlas", "فريق الملاحظات", "Notebook"])(
    "uses repair guidance, not model-generated features, for %s",
    async (projectName) => {
      const test = harness();
      test.createCompletion.mockResolvedValue(validCompletion("Add an interactive route map"));
      const failedInput: PostBuildSuggestionInput = {
        ...INPUT,
        projectName,
        buildOutcome: "failed",
        assistantSummary: "Build failed before preview validation.",
      };
      const result = await generatePostBuildSuggestions(failedInput, test.dependencies);
      expect(result).toEqual({ count: 1, source: "fallback" });
      expect(test.createCompletion).not.toHaveBeenCalled();
      expect(test.loadContext).not.toHaveBeenCalled();
      expect(test.insertSuggestions).toHaveBeenCalledTimes(1);
      expect(test.insertSuggestions).toHaveBeenCalledWith(failedInput, test.inserted[0]);
      expect(test.inserted[0]).toEqual([
        expect.objectContaining({ title: "Diagnose the failed build", category: "fix" }),
      ]);
      const prompt = test.inserted[0]![0]!.prompt;
      expect(prompt).toContain("failed task 901 in this project");
      expect(prompt).toContain("full original brief, saved plan, and conversation requirements");
      expect(prompt).toContain("languages and explicit exclusions");
      expect(prompt).toContain("Preserve existing work");
      expect(prompt).toContain("blocker supported by the evidence");
      expect(prompt).toContain("passed, failed, and unverified");
      expect(prompt.length).toBeLessThanOrEqual(1000);
      expect(prompt).not.toMatch(/MapLibre|Leaflet|polyfill|autoprefixer|simplify|fewer features/i);
      expect(test.diagnostics).toEqual([
        {
          finish_reason: null,
          reasoning_tokens: null,
          output_tokens: null,
          parsed_count: 1,
          failure_category: "recovery_used",
        },
      ]);
    },
  );

  it("does not copy partial requests or raw failure text into the recovery prompt or diagnostics", async () => {
    const test = harness();
    const failedInput: PostBuildSuggestionInput = {
      ...INPUT,
      buildOutcome: "failed",
      userPrompt: "x".repeat(8000) + " Keep English and Arabic; no external integrations.",
      assistantSummary: "RAW_FAILURE_DETAIL_NOT_FOR_IDEAS",
    };
    await generatePostBuildSuggestions(failedInput, test.dependencies);
    expect(test.insertSuggestions.mock.calls[0]?.[0]).toBe(failedInput);
    expect(JSON.stringify([test.inserted, test.diagnostics])).not.toContain(
      "RAW_FAILURE_DETAIL_NOT_FOR_IDEAS",
    );
    expect(test.inserted[0]![0]!.prompt).toContain("full original brief");
    expect(test.createCompletion).not.toHaveBeenCalled();
  });

  it("reports persistence failure without model retries or a false saved count", async () => {
    const test = harness();
    test.insertSuggestions.mockRejectedValue(new Error("database unavailable"));
    const result = await generatePostBuildSuggestions(
      { ...INPUT, buildOutcome: "failed" },
      test.dependencies,
    );
    expect(result).toEqual({ count: 0, source: "none" });
    expect(test.insertSuggestions).toHaveBeenCalledTimes(1);
    expect(test.createCompletion).not.toHaveBeenCalled();
    expect(test.loadContext).not.toHaveBeenCalled();
    expect(test.diagnostics[0]?.failure_category).toBe("persistence_error");
    expectApprovedDiagnosticShape(test.diagnostics[0]!);
  });

  it("keeps successful-build feature suggestions available", async () => {
    const test = harness();
    test.createCompletion.mockResolvedValue(validCompletion());
    expect(
      await generatePostBuildSuggestions(
        { ...INPUT, buildOutcome: "completed" },
        test.dependencies,
      ),
    ).toEqual({ count: 1, source: "model" });
    expect(test.createCompletion).toHaveBeenCalledTimes(1);
  });

  it("gives unknown failures an investigation sequence rather than an invented diagnosis", () => {
    const suggestions = buildFailureFixSuggestions();
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toContain("before identifying the cause");
    expect(suggestions[1]).toContain(
      "original requirements, languages, saved plan, and existing work",
    );
    expect(suggestions[2]).toContain("passed, failed, or remains unverified");
    expect(suggestions.join(" ")).not.toMatch(
      /simplify|fewer features|configure.*secret|browser compatibility|polyfill/i,
    );
    const second = buildFailureFixSuggestions();
    suggestions[0] = "mutated local caller";
    expect(second[0]).not.toBe(suggestions[0]);
  });

  it("wires explicit outcomes at each jobs.ts call site and removes speculative failure-model calls", () => {
    const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile(
      "jobs.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "generatePostBuildSuggestions"
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(calls).toHaveLength(3);
    const outcomes = calls.map((call) => {
      const arg = call.arguments[0]!;
      expect(ts.isObjectLiteralExpression(arg)).toBe(true);
      if (!ts.isObjectLiteralExpression(arg)) throw new Error("Expected an input object");
      const property = arg.properties.find(
        (prop) => ts.isPropertyAssignment(prop) && prop.name.getText(parsed) === "buildOutcome",
      );
      expect(property).toBeDefined();
      if (!property || !ts.isPropertyAssignment(property))
        throw new Error("Missing explicit outcome");
      const outcome = property.initializer.getText(parsed).replaceAll('"', "");
      if (outcome === "failed") {
        expect(arg.getText(parsed)).toContain("Build failed:");
        let ancestor: ts.Node | undefined = call.parent;
        while (ancestor && !ts.isCatchClause(ancestor)) ancestor = ancestor.parent;
        expect(ancestor).toBeDefined();
      }
      if (outcome === "failed") return outcome;
      expect(ts.isCallExpression(property.initializer)).toBe(true);
      if (!ts.isCallExpression(property.initializer))
        throw new Error("Expected evidence classifier");
      expect(property.initializer.expression.getText(parsed)).toBe("postBuildSuggestionOutcome");
      return property.initializer.arguments
        .map((argument) => argument.getText(parsed).replace(/\s+/g, "").replaceAll('"', ""))
        .join("|");
    });
    expect(outcomes.sort()).toEqual([
      "failed",
      "finalReport|finalReport.agentLoop?.completionKind??task.completionKind??finalized|applyTerminal.outcome",
      "report|completionKind|terminal.outcome",
    ]);
    expect(source).not.toContain("generateFixSuggestions(");
    expect(source).toContain("buildFailureFixSuggestions()");
    expect(source).toContain("modelFailureReport?.suggestions ??");
    expect(source).toContain("sealedProjectRecovery?.suggestions ??");
  });
});

describe("build evidence controls next steps", () => {
  const passed = {
    filesChanged: ["src/routes/notes.ts"],
    previewUpdated: true,
    allChecksPassed: true,
    validationReport: { passed: true },
    architectReview: { verdict: "pass", findings: [] },
  };

  it("allows ideas after an explicitly finalized, passing build", () => {
    expect(postBuildSuggestionOutcome(passed, "finalized")).toBe("completed");
  });

  it.each(["step_cap", "wall_clock_cap", "cancelled", "partial", "unknown"])(
    "routes %s completion to evidence-led repair",
    (kind) => expect(postBuildSuggestionOutcome(passed, kind)).toBe("needs_attention"),
  );

  it.each([
    { completedWithErrors: true },
    { completedWithWarnings: true },
    { allChecksPassed: false },
    { previewUpdated: false },
    { warnings: ["Deferred check"] },
    { warningChecks: ["typecheck"] },
    { validationReport: { passed: false } },
    { qualityGate: { passed: false } },
    { qualityGate: { allPassed: false } },
    { checkRunsSummary: { skipped: 1 } },
    { checkRunsSummary: { failed: 1 } },
    { checkRunsSummary: { warnings: 1 } },
    { e2eResults: { failed: 1 } },
    { e2eResults: { skipped: 1 } },
    { architectReview: { verdict: "partial", findings: [] } },
    { architectReview: { verdict: "pass", skipped: true } },
    { architectReview: { verdict: "pass", findings: [{ severity: "critical" }] } },
    { architectReview: { verdict: "pass", findings: [{ severity: "high" }] } },
    { architectReview: { verdict: "pass", findings: [{ severity: "medium" }] } },
  ])("does not equate saved files with successful validation: %j", (report) => {
    expect(postBuildSuggestionOutcome({ ...passed, ...report }, "finalized")).toBe(
      "needs_attention",
    );
  });

  it.each([null, undefined, [], {}, "completed"])(
    "does not infer success from missing report %j",
    (report) => {
      expect(postBuildSuggestionOutcome(report, "finalized")).toBe("needs_attention");
    },
  );

  it("requires affirmative validation and respects the durable terminal outcome", () => {
    expect(postBuildSuggestionOutcome({ filesChanged: [] }, "finalized")).toBe("needs_attention");
    expect(postBuildSuggestionOutcome(passed, "finalized", "changed_with_issues")).toBe(
      "needs_attention",
    );
    expect(postBuildSuggestionOutcome(passed, "finalized", "mutation_succeeded")).toBe("completed");
  });

  it("gives incomplete work a deterministic recovery action without a model call", async () => {
    const test = harness();
    const result = await generatePostBuildSuggestions(
      { ...INPUT, buildOutcome: "needs_attention", assistantSummary: "RAW_PRIVATE_DIAGNOSTIC" },
      test.dependencies,
    );
    expect(result).toEqual({ count: 1, source: "fallback" });
    expect(test.createCompletion).not.toHaveBeenCalled();
    expect(test.loadContext).not.toHaveBeenCalled();
    expect(test.inserted[0]?.[0]).toMatchObject({
      title: "Resolve build findings",
      category: "fix",
    });
    expect(test.inserted[0]?.[0]?.prompt).toContain("task 901 in this project");
    expect(test.inserted[0]?.[0]?.prompt).toContain("deferred");
    expect(JSON.stringify([test.inserted, test.diagnostics])).not.toContain(
      "RAW_PRIVATE_DIAGNOSTIC",
    );
    expect(test.inserted[0]![0]!.prompt.length).toBeLessThanOrEqual(1000);
  });
});

describe("suggestions preserve the complete request and current infrastructure", () => {
  it("retains late privacy and language requirements instead of the first 200 characters", async () => {
    const test = harness();
    test.createCompletion.mockResolvedValue(validCompletion());
    const input = {
      ...INPUT,
      projectFormat: "static-html",
      userPrompt:
        "Inspect existing notes. ".repeat(40) +
        " Keep English and Arabic. Never send unsaved drafts to the server.",
      assistantSummary: "Existing Node server. ".repeat(30),
      filePaths: [
        ...Array.from({ length: 25 }, (_, i) => `src/page${i}.tsx`),
        "nabuflow/runtime/fly-postgres.ts",
      ],
      activeIntegrations: "Legacy Fly Postgres label",
    };
    await generatePostBuildSuggestions(input, test.dependencies);
    const request = test.createCompletion.mock.calls[0]![0];
    const context = JSON.parse(String(request.messages[1]!.content));
    expect(context.originalRequest).toBe(input.userPrompt);
    expect(context.buildSummary).toBe(input.assistantSummary);
    expect(context.filePaths).toEqual(input.filePaths);
    expect(context.platformHint).not.toContain("static web app");
    expect(String(request.messages[0]!.content)).toContain("Cloudflare");
    expect(String(request.messages[0]!.content)).toContain("Neon");
    expect(String(request.messages[0]!.content)).toContain("Fly is retired");
    expect(test.inserted[0]?.[0]?.prompt).toContain("task 901's full original request");
    expect(test.inserted[0]?.[0]?.prompt).toContain("data boundaries");
  });

  it.each(["request", "summary"])("uses deterministic fallback for oversized %s", async (kind) => {
    const oversized =
      kind === "request"
        ? { userPrompt: "x".repeat(16001) }
        : { assistantSummary: "x".repeat(25000) };
    const test = harness();
    const result = await generatePostBuildSuggestions(
      { ...INPUT, ...oversized },
      test.dependencies,
    );
    expect(result.source).toBe("fallback");
    expect(test.createCompletion).not.toHaveBeenCalled();
    expect(test.diagnostics[0]?.failure_category).toBe("context_too_large");
    for (const diagnostic of test.diagnostics) expectApprovedDiagnosticShape(diagnostic);
  });

  it.each(["Fly", "Fly.io", "flyctl", "Fly Postgres"])(
    "rejects retired provider suggestions mentioning %s",
    async (provider) => {
      const test = harness();
      test.createCompletion.mockResolvedValue(
        completion(
          JSON.stringify({
            suggestions: [
              {
                title: "Change database hosting",
                description: "Move to another provider.",
                category: "improvement",
                prompt: `Deploy the database on ${provider}.`,
              },
            ],
          }),
        ),
      );
      const result = await generatePostBuildSuggestions(INPUT, test.dependencies);
      expect(result.source).toBe("fallback");
      expect(test.createCompletion).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(test.inserted)).not.toContain(provider);
    },
  );

  it("keeps a safe suggestion when a sibling violates the provider constraint", async () => {
    const test = harness();
    const safe = JSON.parse(validCompletion().choices[0]!.message.content!).suggestions[0];
    test.createCompletion.mockResolvedValue(
      completion(
        JSON.stringify({
          suggestions: [
            { ...safe, title: "Deploy on Fly", prompt: "Use Fly.io for hosting." },
            { ...safe, title: "Polish the flyout menu" },
          ],
        }),
      ),
    );
    expect(await generatePostBuildSuggestions(INPUT, test.dependencies)).toEqual({
      count: 1,
      source: "model",
    });
    expect(test.inserted[0]?.[0]?.title).toBe("Polish the flyout menu");
  });

  it("rejects an oversized prompt rather than silently removing its ending", async () => {
    const test = harness();
    const suggestion = JSON.parse(validCompletion().choices[0]!.message.content!).suggestions[0];
    test.createCompletion.mockResolvedValue(
      completion(
        JSON.stringify({
          suggestions: [
            {
              ...suggestion,
              prompt: "x".repeat(1000) + " Never store unsaved drafts on the server.",
            },
          ],
        }),
      ),
    );
    expect((await generatePostBuildSuggestions(INPUT, test.dependencies)).source).toBe("fallback");
    expect(test.createCompletion).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(test.inserted)).not.toContain("x".repeat(100));
  });

  it.each(["length", "content_filter", "tool_calls"])(
    "does not persist a parseable but incomplete %s response",
    async (reason) => {
      const test = harness();
      test.createCompletion.mockResolvedValue(
        completion(validCompletion().choices[0]!.message.content, reason),
      );
      expect((await generatePostBuildSuggestions(INPUT, test.dependencies)).source).toBe(
        "fallback",
      );
      expect(test.createCompletion).toHaveBeenCalledTimes(2);
      expect(test.diagnostics.map((d) => d.failure_category)).toEqual([
        "incomplete_response",
        "incomplete_response",
        "fallback_used",
      ]);
    },
  );
});

describe("missing review evidence cannot become a feature recommendation", () => {
  it.each([
    undefined,
    null,
    {},
    { verdict: "pass" },
    { verdict: "pass", findings: [], skipped: true },
  ])("requires an affirmative non-skipped review with findings for %j", (architectReview) => {
    expect(
      postBuildSuggestionOutcome(
        {
          filesChanged: ["src/routes/notes.ts"],
          previewUpdated: true,
          allChecksPassed: true,
          qualityGate: { passed: true, allPassed: true },
          architectReview,
        },
        "finalized",
        "mutation_succeeded",
      ),
    ).toBe("needs_attention");
  });

  it("routes staged apply with an architect timeout to recovery without another model call", async () => {
    const test = harness();
    const report = {
      filesChanged: ["src/routes/notes.ts"],
      previewUpdated: true,
      allChecksPassed: true,
      qualityGate: { passed: true, allPassed: true },
      architectReview: null,
      agentLoop: { completionKind: "finalized" },
    };
    const outcome = postBuildSuggestionOutcome(
      report,
      report.agentLoop.completionKind,
      "mutation_succeeded",
    );
    expect(
      await generatePostBuildSuggestions({ ...INPUT, buildOutcome: outcome }, test.dependencies),
    ).toEqual({ count: 1, source: "fallback" });
    expect(test.createCompletion).not.toHaveBeenCalled();
    expect(test.inserted[0]?.[0]).toMatchObject({
      title: "Resolve build findings",
      category: "fix",
    });
  });
});
