import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const jobs = readFileSync(resolve(here, "jobs.ts"), "utf8");
const loop = readFileSync(resolve(here, "agent-loop.ts"), "utf8");
const messages = readFileSync(resolve(here, "../routes/messages.ts"), "utf8");
const provisioning = readFileSync(resolve(here, "provisioning.ts"), "utf8");
const projects = readFileSync(resolve(here, "../routes/projects.ts"), "utf8");
const backend = readFileSync(
  resolve(here, "../../../nabuflow-runtime-worker/src/runtime-backend.ts"),
  "utf8",
);

const jobsSyntax = ts.createSourceFile(
  "jobs.ts",
  jobs,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function nodesOf<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function optionalReportProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const properties = object.properties.filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === name,
  );
  if (properties.length > 1) throw new Error(`Expected at most one ${name} property`);
  return properties[0]?.initializer;
}

function reportProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
  const property = optionalReportProperty(object, name);
  if (!property) throw new Error(`Expected one ${name} property`);
  return property;
}

function terminalFailureReport(root: ts.Node): ts.Expression {
  const reports = nodesOf(root, ts.isCallExpression)
    .filter(
      (node) =>
        ts.isIdentifier(node.expression) && node.expression.text === "persistFailedZeroTerminal",
    )
    .flatMap((call) => {
      const argument = call.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) return [];
      const update = optionalReportProperty(argument, "taskUpdate");
      if (!update || !ts.isObjectLiteralExpression(update)) return [];
      const report = optionalReportProperty(update, "report");
      return report && ts.isIdentifier(report) && report.text === "failedReport" ? [report] : [];
    });
  if (reports.length !== 1) throw new Error("Expected one failedReport terminal payload");
  return reports[0]!;
}

function failureReportExpressions() {
  const declarations = nodesOf(jobsSyntax, ts.isVariableDeclaration).filter(
    (node) => ts.isIdentifier(node.name) && node.name.text === "failedReport",
  );
  const report = declarations[0]?.initializer;
  if (declarations.length !== 1 || !report || !ts.isObjectLiteralExpression(report)) {
    throw new Error("Expected one failedReport object");
  }
  const spreads = report.properties.filter(ts.isSpreadAssignment);
  const model = spreads.find(
    (node) => node.expression.getText(jobsSyntax) === "(modelFailureReport ?? {})",
  );
  const loop = spreads.find((node) =>
    node.expression.getText(jobsSyntax).includes("sealedFailureReport.agentLoop"),
  );
  if (!model || !loop) throw new Error("Missing original model or loop retention expression");
  const terminal = terminalFailureReport(jobsSyntax);
  const laterReports = nodesOf(jobsSyntax, ts.isObjectLiteralExpression).filter((object) =>
    object.properties.some(
      (node) =>
        ts.isSpreadAssignment(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "failedReport",
    ),
  );
  if (laterReports.length !== 1) {
    throw new Error("Expected one later failedReport persistence payload");
  }
  const later = laterReports[0]!;
  if (
    !ts.isCallExpression(later.parent) ||
    !ts.isPropertyAccessExpression(later.parent.expression) ||
    later.parent.expression.getText(jobsSyntax) !== "JSON.stringify"
  ) {
    throw new Error("Later report must be the persisted JSON payload");
  }
  return {
    warnings: reportProperty(report, "warnings"),
    model: model.expression,
    loop: loop.expression,
    terminal,
    later,
  };
}

describe("Zero sealed generation product wiring", () => {
  it.each([
    ["missing report", "persistFailedZeroTerminal({ taskUpdate: { tokenCount: 0 } });"],
    ["missing update", "persistFailedZeroTerminal({});"],
    ["another report", "persistFailedZeroTerminal({ taskUpdate: { report: otherReport } });"],
    ["another update", "persistFailedZeroTerminal({ taskUpdate: otherUpdate });"],
  ])("selects the intended report despite an unrelated payload with %s", (_label, unrelated) => {
    const fixture = ts.createSourceFile(
      "terminal-fixture.ts",
      `${unrelated}\npersistFailedZeroTerminal({ taskUpdate: { report: failedReport } });`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(terminalFailureReport(fixture).getText(fixture)).toBe("failedReport");
  });

  it.each([
    [
      "missing intended report",
      "persistFailedZeroTerminal({ taskUpdate: { report: otherReport } });",
    ],
    [
      "duplicate intended payload",
      "persistFailedZeroTerminal({ taskUpdate: { report: failedReport } }); persistFailedZeroTerminal({ taskUpdate: { report: failedReport } });",
    ],
    [
      "overridden report",
      "persistFailedZeroTerminal({ taskUpdate: { report: failedReport, report: otherReport } });",
    ],
    [
      "overridden update",
      "persistFailedZeroTerminal({ taskUpdate: { report: failedReport }, taskUpdate: {} });",
    ],
  ])("rejects a terminal report contract with %s", (_label, text) => {
    const fixture = ts.createSourceFile(
      "terminal-fixture.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(() => terminalFailureReport(fixture)).toThrow();
  });

  it("propagates classified model failures before post-loop checks or either sealed wrapper", () => {
    const failureThrow = loop.indexOf("throw modelRequestFailure;");
    const postLoopChecks = loop.indexOf("// \u2500\u2500 Post-loop: run required checks");
    expect(failureThrow).toBeGreaterThan(-1);
    expect(postLoopChecks).toBeGreaterThan(failureThrow);
    expect(loop).toContain("runAgentModelRequest({");
    expect(loop).toContain("recovery: modelRequestRecovery");
    expect(loop).toContain("deadlineAt: startedAt + wallClockMs");
    expect(loop).toContain('safeEvent(input.onEvent, "model:request", JSON.stringify(diagnostic))');
    const buildStart = jobs.indexOf("const USE_AGENT_LOOP_BUILD");
    const buildLoop = jobs.indexOf("const loopRes = await runAgentLoop({", buildStart);
    const buildSeal = jobs.indexOf(
      "zeroSealedGeneration = prepareZeroSealedNodeSource({",
      buildLoop,
    );
    expect(buildStart).toBeGreaterThan(-1);
    expect(buildLoop).toBeGreaterThan(buildStart);
    expect(buildSeal).toBeGreaterThan(buildLoop);
    const refineStart = jobs.indexOf("const USE_AGENT_LOOP_REFINE");
    const refineLoop = jobs.indexOf("const loopRes = await runAgentLoop({", refineStart);
    const refineSeal = jobs.indexOf(
      "const preparedRefinement = prepareZeroSealedNodeRefinement({",
      refineLoop,
    );
    expect(refineStart).toBeGreaterThan(-1);
    expect(refineLoop).toBeGreaterThan(refineStart);
    expect(refineSeal).toBeGreaterThan(refineLoop);
  });

  it("persists the loop report with the terminal and retains it in the later report update", () => {
    expect(jobs).toContain("err instanceof AgentModelRequestError");
    expect(jobs).toContain("modelRequestFailure.failureEvidence");
    expect(jobs).toContain("report: failedReport");
    expect(jobs).toContain("...(draft ? { stagingSnapshot: sealedFailureFiles } : {})");
    expect(jobs).toContain("...(modelFailureReport ?? {})");
    expect(jobs).toContain("completionKind: modelRequestFailure.completionKind");
    expect(jobs).toContain("...(modelFailureReport ?? {})");
    const { warnings } = failureReportExpressions();
    expect(ts.isArrayLiteralExpression(warnings)).toBe(true);
    if (!ts.isArrayLiteralExpression(warnings)) throw new Error("Expected additive warning array");
    expect(
      warnings.elements.map((element) => {
        if (!ts.isSpreadElement(element)) throw new Error("Expected ordered warning spreads");
        let expression = element.expression;
        while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        return expression.getText(jobsSyntax).replace(/\s+/g, "");
      }),
    ).toEqual([
      "modelFailureReport?.warnings??sealedFailureReport?.warnings??[]",
      "committedFileReport?.warnings??[]",
    ]);
    expect(jobs).toMatch(
      /modelFailureReport\?\.suggestions\s*\?\?\s*sealedProjectRecovery\?\.suggestions\s*\?\?\s*buildFailureFixSuggestions\(\)/,
    );
  });

  it.each([
    {
      name: "model report",
      model: { warnings: ["model"], agentLoop: { source: "model" } },
      sealed: { warnings: ["sealed"], agentLoop: { source: "sealed" } },
      expected: ["model"],
      expectedLoop: { source: "model" },
    },
    {
      name: "sealed fallback",
      model: undefined,
      sealed: { warnings: ["sealed"], agentLoop: { source: "sealed" } },
      expected: ["sealed"],
      expectedLoop: { source: "sealed" },
    },
    {
      name: "neither report",
      model: undefined,
      sealed: undefined,
      expected: [],
      expectedLoop: undefined,
    },
    {
      name: "explicit empty model warnings",
      model: { warnings: [], agentLoop: { source: "model" } },
      sealed: { warnings: ["sealed"], agentLoop: { source: "sealed" } },
      expected: [],
      expectedLoop: { source: "model" },
    },
    {
      name: "null model warnings",
      model: { warnings: null, agentLoop: { source: "model" } },
      sealed: { warnings: ["sealed"], agentLoop: { source: "sealed" } },
      expected: ["sealed"],
      expectedLoop: { source: "model" },
    },
    {
      name: "missing model warnings",
      model: {},
      sealed: { warnings: ["sealed"], agentLoop: { source: "sealed" } },
      expected: ["sealed"],
      expectedLoop: undefined,
    },
  ])(
    "retains $name warnings and loop evidence in both persistence payload expressions",
    ({ model, sealed, expected, expectedLoop }) => {
      const expressions = failureReportExpressions();
      for (const receiptWarnings of [undefined, [], ["Files saved; build not proven"]]) {
        const reports = {
          modelFailureReport: model,
          sealedFailureReport: sealed,
          committedFileReport:
            receiptWarnings === undefined ? undefined : { warnings: receiptWarnings },
        };
        const evaluate = (expression: ts.Expression, context: object) =>
          runInNewContext(`(${expression.getText(jobsSyntax)})`, context, { timeout: 1_000 });
        const failedReport = {
          ...evaluate(expressions.model, reports),
          ...evaluate(expressions.loop, reports),
          warnings: evaluate(expressions.warnings, reports),
        };
        const context = {
          failedReport,
          failureTerminal: {},
          zeroTerminalRef: () => "terminal-proof",
          suggestions: ["Retry the build"],
          sealedProjectRecovery: undefined,
        };
        for (const payload of [
          evaluate(expressions.terminal, context),
          evaluate(expressions.later, context),
        ]) {
          expect(payload.warnings).toEqual([...expected, ...(receiptWarnings ?? [])]);
          expect(payload.agentLoop).toEqual(expectedLoop);
        }
      }
    },
  );

  it("selects the target from deployment state and never from the public route", () => {
    expect(jobs).toContain("resolveZeroGenerationTarget(process.env)");
    expect(jobs).toContain("isZeroSealedGenerationTarget(zeroGenerationTarget)");
    // Inspect executable code, not type-only exclusions such as Omit<JobInput,
    // "modelAdapter">, which explicitly prevent exposing the test adapter.
    const runtimeMessages = ts.transpileModule(messages, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    expect(runtimeMessages).not.toContain("modelAdapter");
    expect(runtimeMessages).not.toContain("zeroGenerationTarget");
  });

  it("routes sealed delivery through Pantry and the dock without legacy injection", () => {
    expect(jobs).toContain("runZeroGenerationKitchen(tenantRuntimeProvider");
    expect(jobs).toContain("signal: opts.signal");
    expect(jobs).toContain("supportsZeroGeneration(tenantRuntimeProvider)");
    expect(jobs).toContain("!isZeroSealedGenerationTarget(zeroGenerationTarget)");
    expect(jobs).toContain("syncFilesToContainer");
    expect(jobs).toContain("npmInstallInBackground");
  });

  it("lets an incomplete sealed build continue through the same guarded kitchen path", () => {
    expect(jobs).not.toContain('kind !== "build" || resolvedIsMobile');
    expect(jobs).toContain("prepareZeroSealedNodeRefinement");
    expect(jobs).toContain("zeroSealedGeneration = preparedRefinement");
    expect(jobs).toContain("zeroGenerationTarget,");
  });

  it("routes convertible websites deliberately and keeps incompatible projects typed", () => {
    expect(jobs).toContain("resolveZeroSealedProjectRouting");
    expect(jobs).toContain("projectArtifactsTable");
    expect(jobs).toContain("ZERO_SEALED_PROJECT_TYPE_INCOMPATIBLE");
    expect(jobs).toContain("sealedProjectRecovery");
    expect(jobs).toContain("recoveryAction: sealedProjectRecovery.action");
    expect(jobs).not.toContain("Sealed Zero generation accepts Node API projects only");
  });

  it("keeps source-contract details internal and offers one real repair action", () => {
    expect(jobs).toContain("err instanceof ZeroSealedSourceContractError");
    expect(jobs).toContain("ZERO_SEALED_SOURCE_REPAIR_MESSAGE");
    expect(jobs).toContain("ZERO_SEALED_SOURCE_REPAIR_RECOVERY");
    expect(jobs).not.toContain("generateFixSuggestions(userPrompt, rawMessage)");
  });

  it("injects only the platform-owned non-secret runtime mode after sealing", () => {
    expect(backend).toContain('[TENANT_RUNTIME_MODE_ENV]: "cloudflare-capability-v1"');
    expect(backend).not.toContain("DATABASE_URL:");
    expect(backend).not.toContain("STRIPE_SECRET_KEY:");
  });

  it("keeps sealed runtime provisioning credential-free and accepts a private running descriptor", () => {
    expect(provisioning).toContain("requiresDirectProjectDatabaseProvisioning(process.env)");
    expect(provisioning).toContain("if (!requiresDirectDatabase)");
    expect(projects).toContain("!requiresDirectDatabase || process.env.NEON_API_KEY");
    expect(projects).toContain("deploymentType: sealedDeploymentType");
    expect(jobs).not.toContain('created === null || "error" in created || !created.endpoint');
    expect(jobs).not.toContain("if (!runtimeId || !opts.containerUrl)");
    expect(jobs).not.toContain("zero-task-${taskId}-node-v1");
    // Endpoint-less private runtimes are provisioned when their descriptor is
    // settled. Do not pin the old condition that stranded failed builds.
    expect(jobs.includes("...sealedRuntimeProvisioningState(created.status)")).toBe(true);
    expect(jobs.includes('provisioningStatus: created.endpoint ? "ready" : "provisioning"')).toBe(
      false,
    );
    expect(provisioning.includes("await recoverStaleSealedPreviewProvisioning()")).toBe(true);
    expect(jobs).toContain("healthPath: opts.zeroSealedGeneration.manifest.healthPath");
    expect(jobs).toContain("runtimeId = created.runtimeId");
    expect(jobs).toContain("tenantRuntimeProvider.zeroGenerationRuntimeDescriptor(");
    expect(jobs).toContain("tenantRuntimeProvider.zeroGenerationRuntimeDescriptorForProject(");
    expect(jobs).toContain("runtimeId = existingRuntime.identity");
    expect(jobs).toContain(
      "existingRuntime.manifestRevision === opts.zeroSealedGeneration.manifest.revision",
    );
    expect(jobs).toContain("tenantRuntimeProvider.stop(runtimeId");
    expect(jobs).toContain("reused the matching healthy runtime");
    expect(jobs).not.toContain("runtime.start completed without a durable endpoint");
    expect(jobs).toContain('startedRuntime.status !== "running"');
    expect(jobs).toContain("startedRuntime.identity !== result.runtimeId");
    expect(jobs).toContain("signed grant");
    expect(jobs).toContain("containerUrl: startedRuntime.endpoint");
  });
});
