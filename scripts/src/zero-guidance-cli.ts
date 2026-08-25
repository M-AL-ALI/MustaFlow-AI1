import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  ZERO_GUIDANCE_COVERAGE,
  buildZeroGuidanceInventory,
  renderZeroGuidanceCoverage,
  renderZeroGuidanceManifest,
  zeroGuidanceRepoRoot,
} from "./zero-guidance-manifest";
import {
  ZERO_GUIDANCE_FIXTURE_SET_SHA256,
  ZERO_GUIDANCE_LIVE_CASES,
} from "./zero-guidance-live-cases";
import {
  requiredLiveCoverageIds,
  expectedZeroGuidanceEvaluatedHead,
  ZERO_GUIDANCE_LIVE_RECEIPT_PATH,
  validateZeroGuidanceLiveResult,
  zeroGuidanceChangeRequiresLiveEval,
  type ZeroGuidanceLiveResult,
} from "./zero-guidance-release";

const execFileAsync = promisify(execFile);
const root = zeroGuidanceRepoRoot();
const manifestPath = join(root, "scripts", "zero-guidance", "manifest.json");
const coveragePath = join(root, "scripts", "zero-guidance", "coverage.json");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root, windowsHide: true });
  return stdout.trim();
}

async function writeGenerated(): Promise<void> {
  const inventory = await buildZeroGuidanceInventory(root);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, renderZeroGuidanceManifest(inventory.manifest), "utf8");
  await writeFile(coveragePath, renderZeroGuidanceCoverage(), "utf8");
  console.log(`manifest_sources=${inventory.manifest.sources.length}`);
  console.log(`manifest_sha256=${inventory.manifestSha256}`);
}

async function checkGenerated(): Promise<void> {
  const inventory = await buildZeroGuidanceInventory(root);
  const expectedManifest = renderZeroGuidanceManifest(inventory.manifest);
  const expectedCoverage = renderZeroGuidanceCoverage();
  const actualManifest = await readFile(manifestPath, "utf8");
  const actualCoverage = await readFile(coveragePath, "utf8");
  if (actualManifest !== expectedManifest) {
    throw new Error("zero_guidance_manifest_stale: run zero-guidance:write");
  }
  if (actualCoverage !== expectedCoverage) {
    throw new Error("zero_guidance_coverage_stale: run zero-guidance:write");
  }
  console.log(`manifest_sources=${inventory.manifest.sources.length}`);
  console.log(`manifest_sha256=${inventory.manifestSha256}`);
  console.log("zero_guidance_manifest=PASS");
}

async function changed(): Promise<void> {
  const base = argument("--base");
  const head = argument("--head") ?? "HEAD";
  if (!base) throw new Error("zero_guidance_changed_base_missing");
  const inventory = await buildZeroGuidanceInventory(root);
  const output = await git(["diff", "--name-only", base, head, "--"]);
  const changedPaths = output ? output.split(/\r?\n/u) : [];
  process.stdout.write(
    zeroGuidanceChangeRequiresLiveEval(inventory.manifest, changedPaths) ? "true" : "false",
  );
}

async function validateLive(): Promise<void> {
  const resultPath = argument("--result");
  if (!resultPath) throw new Error("zero_guidance_live_result_path_missing");
  const releaseHead = argument("--head") ?? (await git(["rev-parse", "HEAD"]));
  let parentHead: string | null = null;
  let changedPathsFromParent: string[] = [];
  try {
    parentHead = await git(["rev-parse", `${releaseHead}^`]);
    const changed = await git(["diff", "--name-only", parentHead, releaseHead, "--"]);
    changedPathsFromParent = changed ? changed.split(/\r?\n/u) : [];
  } catch {
    parentHead = null;
    changedPathsFromParent = [];
  }
  const expectedHead = expectedZeroGuidanceEvaluatedHead({
    releaseHead,
    parentHead,
    changedPathsFromParent,
  });
  const inventory = await buildZeroGuidanceInventory(root);
  const result = JSON.parse(
    await readFile(join(root, resultPath), "utf8"),
  ) as ZeroGuidanceLiveResult;
  const validation = validateZeroGuidanceLiveResult({
    result,
    expectedGitSha: expectedHead,
    expectedManifestSha256: inventory.manifestSha256,
    expectedFixtureSetSha256: ZERO_GUIDANCE_FIXTURE_SET_SHA256,
    requiredCoverageIds: requiredLiveCoverageIds(ZERO_GUIDANCE_COVERAGE),
    requiredCases: ZERO_GUIDANCE_LIVE_CASES,
  });
  console.log(JSON.stringify(validation));
  console.log(
    JSON.stringify({
      releaseHead,
      evaluatedHead: expectedHead,
      receiptPath: ZERO_GUIDANCE_LIVE_RECEIPT_PATH,
      receiptOnlyChild: expectedHead !== releaseHead,
    }),
  );
  if (!validation.ok) process.exitCode = 1;
}

const command = process.argv[2];
if (command === "write") await writeGenerated();
else if (command === "check") await checkGenerated();
else if (command === "changed") await changed();
else if (command === "validate-live") await validateLive();
else throw new Error(`zero_guidance_command_invalid: ${command ?? "missing"}`);
