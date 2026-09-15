import {
  isExplicitNoProjectMutationRequest,
  zeroIntentInstructionText,
  type ZeroTerminalStopEvidence,
} from "@workspace/ora-contracts";

type ProjectSourceFile = Readonly<{ path: string; content: string }>;

export interface ReadOnlyValidationReport {
  markdown: string;
  stopEvidence: ZeroTerminalStopEvidence;
  commandExecution: "unavailable";
  checks: ReadonlyArray<{ name: string; status: "skipped"; reason: string }>;
  manifests: ReadonlyArray<{ path: string; status: "parsed" | "invalid"; scripts: string[] }>;
}

const REQUEST_POLITENESS =
  "(?:please[ ,]+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?";
const COMMAND_ACTION =
  "(?:run|execute|perform)\\s+(?:(?:the|these|existing|current|all|installed|available|only)\\s+)*";
const COMMAND_CHECK_TARGET =
  "(?:(?:type[-\\s]?checks?|production[-\\s]build|build|tests?|checks?|scripts?|lint|tsc|vitest)\\b|" +
  "(?:npm|pnpm|yarn|bun|npx)\\s+[^\\n;!?]{0,160}\\b(?:test|build|typecheck|check|lint|tsc|vitest)\\b)";
const COMMAND_REQUEST_PREFIX_END = new RegExp(
  "(?:^|[.!?;\\n]|,\\s*(?:(?:and|then)\\s+)?|\\s+(?:and|then)\\s+)\\s*" +
    REQUEST_POLITENESS +
    COMMAND_ACTION +
    "$",
  "iu",
);
const DIRECT_COMMAND_CHECKS = new RegExp(
  "^\\s*" + REQUEST_POLITENESS + COMMAND_ACTION + COMMAND_CHECK_TARGET,
  "iu",
);
// A conjunction inherits instruction status only from an actual source-reading
// imperative, not a description such as "Our CI will install and run tests".
const PREPARED_COMMAND_CHECKS = new RegExp(
  "^\\s*" +
    REQUEST_POLITENESS +
    "(?:read|inspect|review|check|validate|audit)\\s+" +
    "(?:(?:the|these|all|current|existing|project|package)\\s+)*" +
    "(?:scripts?|files?|source(?:\\s+code)?|manifests?|package\\.json)" +
    "\\s*,?\\s*(?:and\\s+then|and|then)\\s+" +
    REQUEST_POLITENESS +
    COMMAND_ACTION +
    COMMAND_CHECK_TARGET,
  "iu",
);

function requestsCommandChecks(content: string): boolean {
  const instructions = zeroIntentInstructionText(content, (prefix) =>
    // Quoted command names are arguments only; the enclosing clause must still
    // pass the anchored instruction rules below.
    COMMAND_REQUEST_PREFIX_END.test(prefix),
  );
  return instructions
    .split(/[.!?;](?:\s+|$)|\r?\n/u)
    .some(
      (sentence) => DIRECT_COMMAND_CHECKS.test(sentence) || PREPARED_COMMAND_CHECKS.test(sentence),
    );
}

function markdownText(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
}

/**
 * The converse path has source records but no command executor. Preserve that
 * boundary instead of invoking a build, installing tools, or inventing results.
 * Task/message bookkeeping remains separate from generated-project resources.
 */
export function readOnlyValidationReport(
  userPrompt: string,
  currentFiles: readonly ProjectSourceFile[],
): ReadOnlyValidationReport | null {
  if (!isExplicitNoProjectMutationRequest(userPrompt) || !requestsCommandChecks(userPrompt)) {
    return null;
  }

  const manifests: Array<{
    path: string;
    status: "parsed" | "invalid";
    scripts: string[];
  }> = [];
  for (const file of currentFiles) {
    if (!/(?:^|\/)package\.json$/.test(file.path)) continue;
    try {
      const parsed: unknown = JSON.parse(file.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid_package_manifest");
      }
      const scripts = (parsed as Record<string, unknown>).scripts;
      manifests.push({
        path: file.path,
        status: "parsed",
        scripts:
          scripts && typeof scripts === "object" && !Array.isArray(scripts)
            ? Object.entries(scripts)
                .filter(([, command]) => typeof command === "string")
                .map(([name]) => name)
                .sort()
            : [],
      });
    } catch {
      manifests.push({ path: file.path, status: "invalid", scripts: [] });
    }
  }

  const reason =
    "This read-only response has no command executor. Installed tools and side effects cannot be verified, so no project script was run.";
  const checks = [{ name: "Requested command checks", status: "skipped" as const, reason }];
  const manifestLines = manifests.length
    ? manifests.map((manifest) =>
        manifest.status === "invalid"
          ? `- ${markdownText(manifest.path)}: invalid JSON object; no scripts executed.`
          : `- ${markdownText(manifest.path)}: script names ${
              manifest.scripts.length ? manifest.scripts.map(markdownText).join(", ") : "not found"
            }.`,
      )
    : ["- No package.json was found in the supplied project source records."];

  return {
    commandExecution: "unavailable",
    checks,
    manifests,
    stopEvidence: {
      source: "local_contract_fallback",
      fallbackCode: "read_only_execution_unavailable",
    },
    markdown: [
      "## Checks not run",
      "",
      `**SKIPPED:** ${reason}`,
      "",
      "### Package source inspected",
      ...manifestLines,
      "",
      "**Exact commands executed:** none. Source inspection is not a typecheck, build, or passing test result.",
      "",
      "This response did not write project files, install packages, start or stop project services, refresh the runtime, or publish. It inspected stored source records only; concurrent changes by other runs were not audited.",
      "",
      "The app remains unvalidated by this request. Running these checks requires a separate, safely isolated command-execution capability; retrying this same request will not make a missing executor available.",
    ].join("\n"),
  };
}
