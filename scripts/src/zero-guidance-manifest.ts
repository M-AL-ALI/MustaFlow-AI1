import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ZERO_GUIDANCE_MANIFEST_SCHEMA_VERSION = 1 as const;

export type ZeroGuidanceSourceKind =
  | "static-prompt"
  | "context-assembler"
  | "skill-instructions"
  | "skill-eligibility"
  | "blueprint-instructions"
  | "blueprint-eligibility"
  | "sealed-guidance";

export type ZeroGuidanceDeliveryMode = "existing" | "direct" | "sealed";

export interface ZeroGuidanceManifestSource {
  id: string;
  kind: ZeroGuidanceSourceKind;
  sourcePath: string;
  selector: string;
  consumers: string[];
  deliveryModes: ZeroGuidanceDeliveryMode[];
  coverageIds: string[];
  contentSha256: string;
  contentBytes: number;
}

export interface ZeroGuidanceManifest {
  schemaVersion: typeof ZERO_GUIDANCE_MANIFEST_SCHEMA_VERSION;
  sources: ZeroGuidanceManifestSource[];
}

export interface ZeroGuidanceCoverageDefinition {
  id: string;
  layer: "deterministic" | "live";
  description: string;
}

export interface ZeroGuidanceInventory {
  manifest: ZeroGuidanceManifest;
  manifestSha256: string;
  contentBySourceId: ReadonlyMap<string, string>;
}

interface ExplicitSourceSpec {
  id: string;
  kind: ZeroGuidanceSourceKind;
  sourcePath: string;
  selector: { type: "file" } | { type: "function" | "variable"; name: string };
  consumers: string[];
  deliveryModes: ZeroGuidanceDeliveryMode[];
  liveCoverageId: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL_DELIVERY_MODES: ZeroGuidanceDeliveryMode[] = ["existing", "direct", "sealed"];

export const ZERO_GUIDANCE_COVERAGE: ZeroGuidanceCoverageDefinition[] = [
  {
    id: "deterministic:manifest-integrity",
    layer: "deterministic",
    description: "Every consumed source has one stable, sanitized, content-derived manifest row.",
  },
  {
    id: "live:build-generation",
    layer: "live",
    description:
      "Build-family instructions produce complete source under their declared stack contract.",
  },
  {
    id: "live:refinement",
    layer: "live",
    description: "Refinement instructions preserve unaffected behavior and return bounded changes.",
  },
  {
    id: "live:planning",
    layer: "live",
    description:
      "Planning instructions produce structured, actionable plans without generating code.",
  },
  {
    id: "live:intent",
    layer: "live",
    description: "Intent instructions distinguish conversation, planning, and build work.",
  },
  {
    id: "live:conversation",
    layer: "live",
    description: "Conversation instructions respond plainly and choose one useful next step.",
  },
  {
    id: "live:review",
    layer: "live",
    description:
      "Review instructions issue evidence-backed verdicts without inventing missing source.",
  },
  {
    id: "live:developer-intent",
    layer: "live",
    description:
      "Developer-mode instructions debug, refactor, review, or explain without changing intent.",
  },
  {
    id: "live:repair",
    layer: "live",
    description: "Repair instructions make the smallest evidence-backed correction.",
  },
  {
    id: "live:test-planning",
    layer: "live",
    description: "Test-planning instructions cover the requested user-visible behavior.",
  },
  {
    id: "live:agent-loop",
    layer: "live",
    description: "The iterative agent assembly retains its bounded tool and completion contract.",
  },
  {
    id: "live:jobs-context",
    layer: "live",
    description: "Job, repair, and memory context reaches generation with the intended precedence.",
  },
  {
    id: "live:message-routing",
    layer: "live",
    description:
      "Message routing selects the matching prompt family and preserves project context.",
  },
  {
    id: "live:reviewer-context",
    layer: "live",
    description: "Reviewer context is representative, bounded, and explicit about truncation.",
  },
  {
    id: "live:skill-guidance",
    layer: "live",
    description:
      "Skill instructions are discoverable and applied only for the matching task and target.",
  },
  {
    id: "live:blueprint-guidance",
    layer: "live",
    description:
      "Blueprint guidance installs the declared integration contract without hidden handoffs.",
  },
  {
    id: "live:sealed-eligibility",
    layer: "live",
    description:
      "Eligibility metadata selects supported sealed behavior and rejects unsupported behavior clearly.",
  },
  {
    id: "live:sealed-generation",
    layer: "live",
    description:
      "Sealed generation uses capabilities, fixed runtime contracts, and no tenant credentials.",
  },
];

const EXPLICIT_SOURCES: ExplicitSourceSpec[] = [
  {
    id: "assembler:agent-loop:build-system-prompt",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/agent-loop.ts",
    selector: { type: "function", name: "buildSystemPrompt" },
    consumers: ["agent-loop"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:agent-loop",
  },
  {
    id: "assembler:jobs:repair-prompt",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/jobs.ts",
    selector: { type: "function", name: "buildRepairPrompt" },
    consumers: ["jobs", "repair"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:repair",
  },
  {
    id: "assembler:jobs:knowledge-context",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/jobs.ts",
    selector: { type: "function", name: "loadKnowledgeContext" },
    consumers: ["jobs", "knowledge"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:jobs-context",
  },
  {
    id: "assembler:jobs:run-job",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/jobs.ts",
    selector: { type: "function", name: "runJob" },
    consumers: ["jobs", "generation"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:jobs-context",
  },
  {
    id: "assembler:messages:routing",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/routes/messages.ts",
    selector: { type: "file" },
    consumers: ["messages", "intent-routing"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:message-routing",
  },
  {
    id: "assembler:reviewer:file-context",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/reviewer-context.ts",
    selector: { type: "function", name: "buildReviewerContextFromFiles" },
    consumers: ["reviewer"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:reviewer-context",
  },
  {
    id: "assembler:reviewer:workspace-context",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/reviewer-context.ts",
    selector: { type: "function", name: "buildReviewerWorkspaceContext" },
    consumers: ["reviewer"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:reviewer-context",
  },
  {
    id: "assembler:skills:target-index",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/builder-skills.ts",
    selector: { type: "function", name: "listEnabledSkillsForTarget" },
    consumers: ["agent-loop", "skills"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:skill-guidance",
  },
  {
    id: "assembler:skills:target-content",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/builder-skills.ts",
    selector: { type: "function", name: "loadSkillContentForTarget" },
    consumers: ["agent-loop", "skills"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:skill-guidance",
  },
  {
    id: "assembler:skills:format-index",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/builder-skills.ts",
    selector: { type: "function", name: "formatSkillIndex" },
    consumers: ["agent-loop", "skills"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:skill-guidance",
  },
  {
    id: "assembler:blueprints:load",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/blueprints.ts",
    selector: { type: "function", name: "loadBlueprints" },
    consumers: ["blueprints", "agent-loop"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:blueprint-guidance",
  },
  {
    id: "assembler:blueprints:install",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/blueprints.ts",
    selector: { type: "function", name: "installBlueprint" },
    consumers: ["blueprints", "agent-loop"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:blueprint-guidance",
  },
  {
    id: "assembler:knowledge:installed-blueprints",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/knowledge.ts",
    selector: { type: "function", name: "getInstalledBlueprintKnowledge" },
    consumers: ["knowledge", "jobs"],
    deliveryModes: ALL_DELIVERY_MODES,
    liveCoverageId: "live:blueprint-guidance",
  },
  {
    id: "assembler:eligibility:inventory",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/zero-capability-eligibility.ts",
    selector: { type: "function", name: "loadZeroEligibilityInventory" },
    consumers: ["eligibility", "jobs"],
    deliveryModes: ["sealed"],
    liveCoverageId: "live:sealed-eligibility",
  },
  {
    id: "assembler:eligibility:resolve-integration",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/zero-capability-eligibility.ts",
    selector: { type: "function", name: "resolveZeroIntegrationEligibilityOutcome" },
    consumers: ["eligibility", "jobs"],
    deliveryModes: ["sealed"],
    liveCoverageId: "live:sealed-eligibility",
  },
  {
    id: "assembler:eligibility:generated-output",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/zero-capability-eligibility.ts",
    selector: { type: "function", name: "evaluateZeroGeneratedEligibility" },
    consumers: ["eligibility", "jobs"],
    deliveryModes: ["sealed"],
    liveCoverageId: "live:sealed-eligibility",
  },
  {
    id: "guidance:sealed-node:prompt-extension",
    kind: "sealed-guidance",
    sourcePath: "artifacts/api-server/src/lib/zero-sealed-generation.ts",
    selector: { type: "variable", name: "ZERO_SEALED_NODE_PROMPT_EXTENSION" },
    consumers: ["jobs", "sealed-generation"],
    deliveryModes: ["sealed"],
    liveCoverageId: "live:sealed-generation",
  },
  {
    id: "assembler:sealed-node:prepare-source",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/zero-sealed-generation.ts",
    selector: { type: "function", name: "prepareZeroSealedNodeSource" },
    consumers: ["jobs", "sealed-generation"],
    deliveryModes: ["sealed"],
    liveCoverageId: "live:sealed-generation",
  },
  {
    id: "assembler:sealed-node:prepare-refinement",
    kind: "context-assembler",
    sourcePath: "artifacts/api-server/src/lib/zero-sealed-generation.ts",
    selector: { type: "function", name: "prepareZeroSealedNodeRefinement" },
    consumers: ["jobs", "sealed-generation"],
    deliveryModes: ["sealed"],
    liveCoverageId: "live:sealed-generation",
  },
];

function normalizePath(value: string): string {
  return value.split(sep).join("/");
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJsonValue(child)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function extractVariable(text: string, path: string, name: string): string {
  const file = sourceFile(path, text);
  const matches: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (matches.length !== 1 || !matches[0]?.initializer) {
    throw new Error(`zero_guidance_source_selector_invalid: variable ${name} in ${path}`);
  }
  return matches[0].initializer.getText(file);
}

function extractFunction(text: string, path: string, name: string): string {
  const file = sourceFile(path, text);
  const matches: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (matches.length !== 1) {
    throw new Error(`zero_guidance_source_selector_invalid: function ${name} in ${path}`);
  }
  return matches[0]!.getText(file);
}

function promptCoverage(name: string): string {
  if (name.includes("INTENT")) return "live:intent";
  if (name.includes("REFINE")) return "live:refinement";
  if (name.includes("PLAN")) return "live:planning";
  if (/(?:CONVERSE|CLARIFY|EXPLAIN)/u.test(name)) return "live:conversation";
  if (/(?:ARCHITECT|CRITIQUE|REVIEW)/u.test(name)) return "live:review";
  if (/(?:DEBUG|REFACTOR)/u.test(name)) return "live:developer-intent";
  if (name.includes("TEST_GENERATION")) return "live:test-planning";
  if (/(?:FIX|PATCH|REPAIR)/u.test(name)) return "live:repair";
  return "live:build-generation";
}

function promptDeclarations(text: string, path: string): { name: string; content: string }[] {
  const file = sourceFile(path, text);
  const found: { name: string; content: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (node.name.text.endsWith("_SYSTEM_PROMPT") || node.name.text === "INTENT_CLASSIFIER_SYSTEM")
    ) {
      found.push({ name: node.name.text, content: node.initializer.getText(file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function manifestSource(
  spec: Omit<ZeroGuidanceManifestSource, "contentSha256" | "contentBytes">,
  content: string,
): ZeroGuidanceManifestSource {
  const normalized = normalizeText(content);
  return {
    ...spec,
    consumers: [...spec.consumers].sort(),
    deliveryModes: [...spec.deliveryModes].sort(),
    coverageIds: [...spec.coverageIds].sort(),
    contentSha256: sha256(normalized),
    contentBytes: Buffer.byteLength(normalized, "utf8"),
  };
}

async function readNormalized(root: string, sourcePath: string): Promise<string> {
  const raw = await readFile(join(root, sourcePath), "utf8");
  if (sourcePath.endsWith(".json")) return stableJson(JSON.parse(raw) as unknown).trimEnd();
  return normalizeText(raw);
}

async function dynamicDirectories(root: string, relativeRoot: string): Promise<string[]> {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
}

export function zeroGuidanceRepoRoot(): string {
  return REPO_ROOT;
}

export async function buildZeroGuidanceInventory(root = REPO_ROOT): Promise<ZeroGuidanceInventory> {
  const resolvedRoot = resolve(root);
  const rows: ZeroGuidanceManifestSource[] = [];
  const contentBySourceId = new Map<string, string>();

  for (const sourcePath of [
    "artifacts/api-server/src/lib/builder.ts",
    "artifacts/api-server/src/lib/architect.ts",
  ]) {
    const text = await readNormalized(resolvedRoot, sourcePath);
    const owner = sourcePath.endsWith("architect.ts") ? "architect" : "builder";
    for (const prompt of promptDeclarations(text, sourcePath)) {
      const id = `prompt:${owner}:${prompt.name}`;
      const content = normalizeText(prompt.content);
      rows.push(
        manifestSource(
          {
            id,
            kind: "static-prompt",
            sourcePath,
            selector: `variable:${prompt.name}`,
            consumers: [owner],
            deliveryModes: ALL_DELIVERY_MODES,
            coverageIds: ["deterministic:manifest-integrity", promptCoverage(prompt.name)],
          },
          content,
        ),
      );
      contentBySourceId.set(id, content);
    }
  }

  for (const spec of EXPLICIT_SOURCES) {
    const fileText = await readNormalized(resolvedRoot, spec.sourcePath);
    const content =
      spec.selector.type === "file"
        ? fileText
        : spec.selector.type === "function"
          ? extractFunction(fileText, spec.sourcePath, spec.selector.name)
          : extractVariable(fileText, spec.sourcePath, spec.selector.name);
    rows.push(
      manifestSource(
        {
          id: spec.id,
          kind: spec.kind,
          sourcePath: spec.sourcePath,
          selector:
            spec.selector.type === "file" ? "file" : `${spec.selector.type}:${spec.selector.name}`,
          consumers: spec.consumers,
          deliveryModes: spec.deliveryModes,
          coverageIds: ["deterministic:manifest-integrity", spec.liveCoverageId],
        },
        content,
      ),
    );
    contentBySourceId.set(spec.id, normalizeText(content));
  }

  for (const skill of await dynamicDirectories(resolvedRoot, "skills")) {
    for (const [fileName, kind, coverageId, modes] of [
      ["SKILL.md", "skill-instructions", "live:skill-guidance", ["existing", "direct"]],
      ["eligibility.json", "skill-eligibility", "live:sealed-eligibility", ["sealed"]],
    ] as const) {
      const sourcePath = `skills/${skill}/${fileName}`;
      const content = await readNormalized(resolvedRoot, sourcePath);
      const id = `skill:${skill}:${fileName === "SKILL.md" ? "instructions" : "eligibility"}`;
      rows.push(
        manifestSource(
          {
            id,
            kind,
            sourcePath,
            selector: "file",
            consumers: ["agent-loop", "builder-skills"],
            deliveryModes: [...modes],
            coverageIds: ["deterministic:manifest-integrity", coverageId],
          },
          content,
        ),
      );
      contentBySourceId.set(id, content);
    }
  }

  for (const blueprint of await dynamicDirectories(resolvedRoot, "blueprints")) {
    for (const [fileName, kind, coverageId, modes] of [
      ["blueprint.json", "blueprint-instructions", "live:blueprint-guidance", ALL_DELIVERY_MODES],
      ["eligibility.json", "blueprint-eligibility", "live:sealed-eligibility", ["sealed"]],
    ] as const) {
      const sourcePath = `blueprints/${blueprint}/${fileName}`;
      const content = await readNormalized(resolvedRoot, sourcePath);
      const id = `blueprint:${blueprint}:${fileName === "blueprint.json" ? "document" : "eligibility"}`;
      rows.push(
        manifestSource(
          {
            id,
            kind,
            sourcePath,
            selector: "file",
            consumers: ["agent-loop", "jobs", "knowledge"],
            deliveryModes: [...modes],
            coverageIds: ["deterministic:manifest-integrity", coverageId],
          },
          content,
        ),
      );
      contentBySourceId.set(id, content);
    }
  }

  rows.sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`zero_guidance_duplicate_source_identity: ${row.id}`);
    ids.add(row.id);
    if (row.sourcePath.startsWith("/") || /^[A-Za-z]:/u.test(row.sourcePath)) {
      throw new Error(`zero_guidance_absolute_source_path: ${row.sourcePath}`);
    }
  }

  const manifest: ZeroGuidanceManifest = {
    schemaVersion: ZERO_GUIDANCE_MANIFEST_SCHEMA_VERSION,
    sources: rows,
  };
  const rendered = stableJson(manifest);
  return { manifest, manifestSha256: sha256(rendered), contentBySourceId };
}

export function renderZeroGuidanceManifest(manifest: ZeroGuidanceManifest): string {
  return stableJson(manifest);
}

export function renderZeroGuidanceCoverage(): string {
  return stableJson({
    schemaVersion: ZERO_GUIDANCE_MANIFEST_SCHEMA_VERSION,
    coverage: [...ZERO_GUIDANCE_COVERAGE].sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function repoRelativePath(root: string, value: string): string {
  return normalizePath(relative(resolve(root), resolve(value)));
}
