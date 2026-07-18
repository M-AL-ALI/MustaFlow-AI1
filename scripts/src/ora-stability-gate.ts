import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Profile = "fast" | "website" | "mobile" | "release";
type GateStatus = "pass" | "fail" | "warn";

interface GateCheck {
  id: string;
  title: string;
  area: string;
  command: string;
  profiles: Array<"fast" | "website" | "mobile" | "release">;
  timeoutMs?: number;
  critical?: boolean;
  why: string;
}

interface CheckResult {
  id: string;
  title: string;
  area: string;
  status: GateStatus;
  durationMs: number;
  command?: string;
  exitCode?: number | null;
  output?: string;
  why: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const PROFILE_GROUPS: Record<Profile, Set<GateCheck["profiles"][number]>> = {
  fast: new Set(["fast"]),
  website: new Set(["fast", "website"]),
  mobile: new Set(["fast", "mobile"]),
  release: new Set(["fast", "website", "mobile", "release"]),
};

const DEFAULT_NODE_OPTIONS = "--max-old-space-size=4096";
const DEFAULT_TIMEOUT_MS = 180_000;

const API_PUBLIC_AI_CORE = [
  "src/lib/public-ai/__tests__/current-datetime-block.test.ts",
  "src/lib/public-ai/__tests__/model-router.test.ts",
  "src/lib/public-ai/__tests__/ora-behavior-qa.test.ts",
  "src/lib/public-ai/__tests__/ora-conversation-smoke.test.ts",
  "src/lib/public-ai/__tests__/ora-quality-identity.test.ts",
  "src/lib/public-ai/__tests__/response-quality.test.ts",
  "src/lib/public-ai/__tests__/routing-diagnostics.test.ts",
].join(" ");

const API_FILE_IMAGE = [
  "src/lib/public-ai/__tests__/dataset-workflow.test.ts",
  "src/lib/public-ai/__tests__/export-content.test.ts",
  "src/lib/public-ai/__tests__/ora-image-quality.test.ts",
  "src/lib/public-ai/__tests__/professional-doc.test.ts",
  "src/routes/public-ai/__tests__/export-file.test.ts",
].join(" ");

const API_SEARCH = [
  "src/lib/public-ai/__tests__/ora-research-trigger.test.ts",
  "src/routes/public-ai/__tests__/search-fallback.test.ts",
  "src/routes/public-ai/__tests__/search-routing.test.ts",
  "src/routes/public-ai/__tests__/search-source-links.test.ts",
].join(" ");

const API_REALTIME = [
  "src/routes/public-ai/__tests__/realtime-session.test.ts",
  "src/routes/public-ai/__tests__/voice-session.test.ts",
].join(" ");

const API_RELEASE_EXTENDED = [
  "src/lib/public-ai/document-prompt.test.ts",
  "src/lib/public-ai/memory-consolidation.test.ts",
  "src/lib/public-ai/ora-file-handling.test.ts",
  "src/lib/public-ai/__tests__/authed-user.test.ts",
  "src/lib/public-ai/__tests__/conversation-summary.test.ts",
  "src/lib/public-ai/__tests__/expertise.test.ts",
  "src/lib/public-ai/__tests__/extract-prose-videos.test.ts",
  "src/lib/public-ai/__tests__/ora-contracts-dataset.test.ts",
  "src/routes/public-ai/__tests__/memory-extract.test.ts",
  "src/routes/public-ai/__tests__/memory-sensitive.test.ts",
  "src/routes/public-ai/__tests__/ora-chat-response-qa.test.ts",
  "src/routes/public-ai/__tests__/ora-context-quality.test.ts",
  "src/routes/public-ai/__tests__/ora-isolation.test.ts",
  "src/routes/public-ai/__tests__/ora-kill-switches.test.ts",
  "src/routes/public-ai/__tests__/ora-production-safety.test.ts",
  "src/routes/public-ai/__tests__/ora-smoke.test.ts",
  "src/routes/public-ai/__tests__/ora-spend-cap.test.ts",
  "src/routes/public-ai/__tests__/ora-streaming.test.ts",
  "src/routes/public-ai/__tests__/ora-usage.test.ts",
  "src/routes/public-ai/__tests__/search-image-cards.test.ts",
  "src/routes/public-ai/__tests__/search-media.test.ts",
  "src/routes/public-ai/__tests__/search-video-cards.test.ts",
  "src/routes/public-ai/__tests__/search-wants-videos.test.ts",
  "src/routes/__tests__/ora-image-edit.test.ts",
  "src/lib/public-ai/__tests__/ora-realtime-usage.test.ts",
  "src/routes/public-ai/__tests__/realtime-metering.test.ts",
].join(" ");

const API_ACCOUNT_BILLING_HISTORY = [
  "src/routes/__tests__/admin-ora-monitoring.test.ts",
  "src/routes/__tests__/admin-ora-routing-diagnostics.test.ts",
  "src/routes/__tests__/billing-ora-plans-public.test.ts",
  "src/routes/__tests__/billing-subscription-checkout.test.ts",
  "src/routes/__tests__/ora-account-consistency.test.ts",
  "src/routes/__tests__/ora-assets.test.ts",
  "src/routes/__tests__/ora-conversation-persistence.test.ts",
  "src/routes/__tests__/ora-memory-consolidation.test.ts",
  "src/routes/__tests__/ora-memory-enhancements.test.ts",
  "src/routes/__tests__/ora-memory-relevance.test.ts",
  "src/routes/__tests__/ora-support-surface-isolation.test.ts",
  "src/routes/__tests__/ora-tiers-meta.test.ts",
].join(" ");

const WEB_REALTIME = [
  "src/hooks/__tests__/ora-realtime-focus.test.ts",
  "src/hooks/__tests__/ora-realtime-multi-turn.test.ts",
  "src/hooks/__tests__/ora-realtime-reconnect.test.ts",
  "src/hooks/__tests__/ora-realtime-settle.test.ts",
  "src/lib/__tests__/ora-realtime-watchdog.test.ts",
].join(" ");

const WEB_ORA_UI = [
  "src/components/ora/__tests__/ora-chat-ux-wiring.test.ts",
  "src/lib/__tests__/blocker-fixes-b39.test.ts",
  "src/pages/__tests__/billing-plan-cards.test.ts",
  "src/pages/__tests__/ora-account-sync-wiring.test.ts",
  "src/pages/__tests__/ora-live-voice-privacy.test.ts",
  "src/pages/__tests__/ora-realtime-reconnect-ui.test.ts",
  "src/pages/__tests__/pricing-deeplink.test.ts",
].join(" ");

const WEB_RELEASE_EXTENDED = [
  "src/components/admin/__tests__/ora-routing-diagnostics-panel.test.ts",
  "src/components/ora/__tests__/ora-memory-manager.test.tsx",
  "src/components/ora/__tests__/ora-message-actions.test.tsx",
  "src/components/ora/__tests__/ora-rich-text.test.tsx",
  "src/components/ora/__tests__/ora-source-cards.test.tsx",
  "src/hooks/__tests__/ora-stream-diagnostics.test.ts",
  "src/hooks/__tests__/ora-upload-gating.test.ts",
  "src/lib/file-generation/__tests__/analyst-workflow-export.test.ts",
  "src/lib/__tests__/ora-project-scope.test.ts",
].join(" ");

const MOBILE_LIB_CRITICAL = [
  "lib/__tests__/account-sync-wiring.test.ts",
  "lib/__tests__/billing-plan-cards.test.ts",
  "lib/__tests__/generate-file-wiring.test.ts",
  "lib/__tests__/live-voice-privacy.test.ts",
  "lib/__tests__/ora-mobile-parity.test.ts",
  "lib/__tests__/safe-url.test.ts",
].join(" ");

const CHECKS: GateCheck[] = [
  {
    id: "api-typecheck",
    title: "API server typecheck",
    area: "build",
    command: "pnpm --filter @workspace/api-server run typecheck",
    profiles: ["fast"],
    critical: true,
    why: "Catches backend, routing, prompt, file, search, auth, and quota TypeScript breakage.",
  },
  {
    id: "web-typecheck",
    title: "Website typecheck",
    area: "build",
    command: "pnpm --filter @workspace/mustaflow run typecheck",
    profiles: ["fast"],
    critical: true,
    why: "Catches website Ora UI, composer, history, voice, and file-card compile regressions.",
  },
  {
    id: "mobile-typecheck",
    title: "Mobile typecheck",
    area: "build",
    command: "pnpm --filter @workspace/ora-mobile run typecheck",
    profiles: ["fast"],
    critical: true,
    why: "Catches iOS/Android Ora chat, voice, upload, settings, and compliance compile regressions.",
  },
  {
    id: "api-core-routing-quality",
    title: "API Ora core routing, identity, date/time, and quality tests",
    area: "api/routing",
    command: `pnpm --filter @workspace/api-server exec vitest run ${API_PUBLIC_AI_CORE} --no-file-parallelism`,
    profiles: ["fast"],
    critical: true,
    why: "Protects the routing brain, Ora identity, current date/time block, copied-report analysis, and response quality.",
  },
  {
    id: "api-search-current-info",
    title: "API live search and current-info tests",
    area: "api/search",
    command: `pnpm --filter @workspace/api-server exec vitest run ${API_SEARCH} --no-file-parallelism`,
    profiles: ["fast"],
    critical: true,
    why: "Protects live search, retry/fallback behavior, source links, news/current/sports routing, and no stale-current answers.",
  },
  {
    id: "api-files-images",
    title: "API file, chart, export, and image tests",
    area: "api/files-images",
    command: `pnpm --filter @workspace/api-server exec vitest run ${API_FILE_IMAGE} --no-file-parallelism`,
    profiles: ["fast"],
    critical: true,
    why: "Protects image routing/quality, real file generation, PDF/Word/Excel/PPTX/CSV export, and chart/report workflows.",
  },
  {
    id: "api-realtime-voice",
    title: "API realtime voice/session tests",
    area: "api/voice",
    command: `pnpm --filter @workspace/api-server exec vitest run ${API_REALTIME} --no-file-parallelism`,
    profiles: ["fast"],
    critical: true,
    why: "Protects voice-session minting, usage metering, time-budget rules, and server prompt wiring.",
  },
  {
    id: "web-realtime-voice",
    title: "Website Talk to Ora realtime tests",
    area: "web/voice",
    command: `pnpm --filter @workspace/mustaflow exec vitest run --config vitest.config.ts ${WEB_REALTIME}`,
    profiles: ["fast"],
    critical: true,
    why: "Protects web voice focus, settle window, reconnect ladder, watchdogs, and multi-turn stability.",
  },
  {
    id: "web-ora-ui-critical",
    title: "Website Ora UI/account/billing wiring tests",
    area: "web/ui",
    command: `pnpm --filter @workspace/mustaflow exec vitest run --config vitest.config.ts ${WEB_ORA_UI}`,
    profiles: ["fast"],
    critical: true,
    why: "Protects composer/file cards, account sync, billing cards, realtime UI, privacy, and pricing deep links.",
  },
  {
    id: "mobile-lib-critical",
    title: "Mobile Ora parity and wiring tests",
    area: "mobile/ui",
    command: `pnpm --filter @workspace/ora-mobile exec vitest run ${MOBILE_LIB_CRITICAL}`,
    profiles: ["fast", "mobile"],
    critical: true,
    why: "Protects mobile web parity, file-generation wiring, billing compliance, account sync, safe URLs, and voice privacy.",
  },
  {
    id: "mobile-realtime-hook",
    title: "Mobile Talk to Ora reconnect hook tests",
    area: "mobile/voice",
    command:
      "pnpm --filter @workspace/ora-mobile exec vitest run --config vitest.config.hooks.ts hooks/__tests__/ora-mobile-reconnect.test.ts",
    profiles: ["fast", "mobile"],
    critical: true,
    why: "Protects native Talk to Ora reconnect/time-budget behavior on mobile.",
  },
  {
    id: "api-release-extended",
    title: "API extended Ora route/search/memory/streaming tests",
    area: "api/release",
    command: `pnpm --filter @workspace/api-server exec vitest run ${API_RELEASE_EXTENDED} --no-file-parallelism`,
    profiles: ["release"],
    timeoutMs: 300_000,
    critical: true,
    why: "Adds broader route, memory, streaming, kill-switch, production-safety, and media-card coverage before release.",
  },
  {
    id: "api-account-billing-history",
    title: "API account, billing, assets, memory, and history tests",
    area: "api/release",
    command: `pnpm --filter @workspace/api-server exec vitest run ${API_ACCOUNT_BILLING_HISTORY} --no-file-parallelism`,
    profiles: ["release"],
    timeoutMs: 300_000,
    critical: true,
    why: "Protects plan sync, billing public metadata, conversation persistence, account consistency, assets, and memory.",
  },
  {
    id: "web-release-extended",
    title: "Website extended Ora UI/file/source/history tests",
    area: "web/release",
    command: `pnpm --filter @workspace/mustaflow exec vitest run --config vitest.config.ts ${WEB_RELEASE_EXTENDED}`,
    profiles: ["release", "website"],
    timeoutMs: 240_000,
    critical: true,
    why: "Adds web routing diagnostics panel, rich-text/source cards, upload gating, memory manager, and analyst export coverage.",
  },
  {
    id: "api-build",
    title: "API server production build",
    area: "build/release",
    command: "pnpm --filter @workspace/api-server run build",
    profiles: ["release"],
    timeoutMs: 300_000,
    critical: true,
    why: "Proves the backend bundles with current dependencies and dynamic imports.",
  },
  {
    id: "web-build",
    title: "Website production build",
    area: "build/release",
    command: "pnpm --filter @workspace/mustaflow run build",
    profiles: ["release", "website"],
    timeoutMs: 420_000,
    critical: true,
    why: "Proves the published website can build and prerender with current Ora UI changes.",
  },
  {
    id: "lint",
    title: "Workspace lint",
    area: "build/release",
    command: "pnpm run lint",
    profiles: ["release"],
    timeoutMs: 240_000,
    critical: true,
    why: "Catches hook dependency regressions and release-blocking lint errors.",
  },
];

const MANUAL_CHECKLIST = [
  {
    area: "Website chat",
    items: [
      "Ask a normal chat question in Instant and confirm a complete answer.",
      "Ask a Deep question on a paid account and confirm streaming begins quickly and finishes.",
      "Ask 'What is today's date?' and confirm the exact current date/time is correct.",
    ],
  },
  {
    area: "Search/current info",
    items: [
      "Ask 'What is the news today?' and confirm live sources appear or the honest retryable search error appears.",
      "Tap Retry live search and confirm it re-runs search instead of printing another stale fallback.",
      "Ask a sports schedule question and confirm Ora searches for teams/times/sources.",
    ],
  },
  {
    area: "Talk to Ora",
    items: [
      "Run at least 10 consecutive web voice turns without stuck thinking, silent text-only replies, or disconnect.",
      "Run at least 10 consecutive TestFlight voice turns on iPhone after any mobile hook change.",
      "Interrupt Ora mid-reply and confirm barge-in works without killing the session.",
      "Confirm the session ends by tier time budget, not by number of exchanges.",
    ],
  },
  {
    area: "Images",
    items: [
      "Generate an inline image from a plain request.",
      "Edit/refine the previous image and confirm it remains an image flow.",
      "Ask for an image lookup and confirm it routes to search, not generation.",
    ],
  },
  {
    area: "Files and advanced analyst workflow",
    items: [
      "Upload PDF, DOCX, PPTX, XLSX, CSV, TXT, and ZIP samples and ask Ora to summarize/analyze each.",
      "Generate PDF, DOCX, PPTX, XLSX, and CSV files and confirm real file cards appear.",
      "Confirm PDF has separate View and Download controls.",
      "Ask for charts/histograms/dashboard from tabular data and confirm real visuals appear in exported files.",
      "Ask for a revision to a generated file and confirm a new complete replacement file is returned.",
    ],
  },
  {
    area: "Account, billing, and compliance",
    items: [
      "Confirm website and mobile show the same plan/tier/usage for the same user.",
      "Confirm paid users are not blocked by anonymous session limits.",
      "On iOS, confirm no external checkout/pricing links are visible.",
      "Confirm Sign in with Apple is visible on iOS sign-in/sign-up.",
      "Confirm Delete account flow is present and works on TestFlight before App Store resubmission.",
    ],
  },
  {
    area: "History and cross-platform parity",
    items: [
      "Create, rename, pin, archive, restore, and search conversations on website.",
      "Open mobile and confirm conversation history, last-active conversation, file/image badges, and pinned/archive behavior match.",
    ],
  },
  {
    area: "Production release",
    items: [
      "Record the commit SHA being published/submitted.",
      "After website publish, confirm /api/healthz returns 200 and the website loads.",
      "Watch logs for 401/429/500/502 spikes after publish.",
      "If mobile code changed, cut a fresh TestFlight build and run the mobile manual checks before App Store submission.",
      "Record rollback SHA and do not release if any critical automated or manual item fails.",
    ],
  },
];

function parseArgs() {
  let profile: Profile = "fast";
  let reportPath: string | null = null;
  let requireClean = false;
  let list = false;
  let failFast = false;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]!;
    if (arg === "--require-clean") {
      requireClean = true;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--fail-fast") {
      failFast = true;
    } else if (arg.startsWith("--profile=")) {
      profile = parseProfile(arg.slice("--profile=".length));
    } else if (arg === "--profile") {
      profile = parseProfile(process.argv[++i]);
    } else if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    } else if (arg === "--report") {
      reportPath = process.argv[++i] ?? null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { profile, reportPath, requireClean, list, failFast };
}

function parseProfile(value: string | undefined): Profile {
  if (value === "fast" || value === "website" || value === "mobile" || value === "release") {
    return value;
  }
  throw new Error(`Invalid --profile. Expected fast, website, mobile, or release; got ${value}`);
}

function runShell(
  command: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): {
  exitCode: number | null;
  output: string;
  durationMs: number;
} {
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "test",
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? DEFAULT_NODE_OPTIONS,
      CI: process.env.CI ?? "1",
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgresql://ora_gate:ora_gate@127.0.0.1:5432/ora_gate",
      ORA_SESSION_SECRET:
        process.env.ORA_SESSION_SECRET ?? "ora-stability-gate-local-test-session-secret",
      AI_INTEGRATIONS_OPENAI_BASE_URL:
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://example.invalid/v1",
      AI_INTEGRATIONS_OPENAI_API_KEY:
        process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? "sk-ora-stability-gate-test",
    },
  });
  const durationMs = Date.now() - start;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    exitCode: result.status,
    output: result.error ? `${output}\n${result.error.message}`.trim() : output,
    durationMs,
  };
}

function tail(value: string, maxLines = 80): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function relevantChecks(profile: Profile): GateCheck[] {
  const groups = PROFILE_GROUPS[profile];
  return CHECKS.filter((check) => check.profiles.some((p) => groups.has(p)));
}

function commandResult(check: GateCheck): CheckResult {
  console.log(`\n[ora-gate] ${check.id}: ${check.title}`);
  console.log(`[ora-gate] ${check.command}`);
  const { exitCode, output, durationMs } = runShell(check.command, check.timeoutMs);
  const status: GateStatus = exitCode === 0 ? "pass" : "fail";
  console.log(`[ora-gate] ${status.toUpperCase()} ${check.id} (${Math.round(durationMs / 1000)}s)`);
  if (status === "fail" && output) {
    console.log(tail(output, 40));
  }
  return {
    id: check.id,
    title: check.title,
    area: check.area,
    status,
    durationMs,
    command: check.command,
    exitCode,
    output: tail(output),
    why: check.why,
  };
}

function gitInfo(requireClean: boolean): CheckResult[] {
  const sha = runShell("git rev-parse HEAD", 20_000);
  const branch = runShell("git branch --show-current", 20_000);
  const status = runShell("git status --short", 20_000);
  const dirty = status.output.trim().length > 0;
  const cleanStatus: GateStatus = dirty && requireClean ? "fail" : dirty ? "warn" : "pass";
  return [
    {
      id: "git-commit",
      title: "Git commit SHA",
      area: "preflight",
      status: sha.exitCode === 0 ? "pass" : "fail",
      durationMs: sha.durationMs,
      command: "git rev-parse HEAD",
      exitCode: sha.exitCode,
      output: `branch: ${branch.output || "(detached)"}\nsha: ${sha.output}`,
      why: "Every release report must name the exact code under test.",
    },
    {
      id: "git-clean",
      title: requireClean ? "Working tree must be clean" : "Working tree status",
      area: "preflight",
      status: cleanStatus,
      durationMs: status.durationMs,
      command: "git status --short",
      exitCode: status.exitCode,
      output: dirty ? status.output : "clean",
      why: requireClean
        ? "Publishing/TestFlight reports must not be created from uncommitted changes."
        : "Dirty changes are allowed during development but must be disclosed in the report.",
    },
  ];
}

function renderReport(input: {
  profile: Profile;
  results: CheckResult[];
  startedAt: Date;
  finishedAt: Date;
}): string {
  const failed = input.results.filter((r) => r.status === "fail");
  const warned = input.results.filter((r) => r.status === "warn");
  const passed = input.results.filter((r) => r.status === "pass");
  const releaseDecision =
    failed.length === 0
      ? "AUTOMATED GATE PASSED. Manual checklist is still required before publish/TestFlight."
      : "AUTOMATED GATE FAILED. Do not publish or submit TestFlight.";

  const lines: string[] = [];
  lines.push("# Ora Stability Gate Report");
  lines.push("");
  lines.push(`Profile: ${input.profile}`);
  lines.push(`Started: ${input.startedAt.toISOString()}`);
  lines.push(`Finished: ${input.finishedAt.toISOString()}`);
  lines.push(`Decision: ${releaseDecision}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Passed: ${passed.length}`);
  lines.push(`- Warnings: ${warned.length}`);
  lines.push(`- Failed: ${failed.length}`);
  lines.push("");
  lines.push("## Automated Checks");
  lines.push("");
  lines.push("| Status | Area | Check | Duration |");
  lines.push("| --- | --- | --- | ---: |");
  for (const result of input.results) {
    lines.push(
      `| ${result.status.toUpperCase()} | ${result.area} | ${result.id} - ${escapePipe(result.title)} | ${Math.round(result.durationMs / 1000)}s |`,
    );
  }
  lines.push("");
  lines.push("## Details");
  for (const result of input.results) {
    lines.push("");
    lines.push(`### ${result.status.toUpperCase()} - ${result.id}`);
    lines.push("");
    lines.push(`Area: ${result.area}`);
    lines.push(`Why: ${result.why}`);
    if (result.command) lines.push(`Command: \`${result.command}\``);
    if (result.exitCode !== undefined) lines.push(`Exit code: ${result.exitCode}`);
    if (result.output) {
      lines.push("");
      lines.push("```text");
      lines.push(result.output);
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("## Required Manual Checks");
  lines.push("");
  lines.push(
    "Automation cannot prove production auth, Apple review behavior, physical-device audio, or real provider availability. Complete these before publish/TestFlight:",
  );
  for (const group of MANUAL_CHECKLIST) {
    lines.push("");
    lines.push(`### ${group.area}`);
    for (const item of group.items) lines.push(`- [ ] ${item}`);
  }
  lines.push("");
  lines.push("## Release Rule");
  lines.push("");
  lines.push(
    "No feature is safe to publish just because that feature works. Publish or submit TestFlight only when this automated gate passes and the required manual checks for the changed surfaces pass.",
  );
  lines.push("");
  return lines.join("\n");
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function listChecks(profile: Profile) {
  console.log(`Ora Stability Gate checks for profile "${profile}":`);
  for (const check of relevantChecks(profile)) {
    console.log(`- ${check.id} [${check.area}] ${check.title}`);
  }
}

async function main() {
  const { profile, reportPath, requireClean, list, failFast } = parseArgs();
  if (list) {
    listChecks(profile);
    return;
  }

  const startedAt = new Date();
  console.log(`[ora-gate] Starting Ora Stability Gate profile=${profile}`);
  console.log(`[ora-gate] Repo: ${repoRoot}`);

  const results: CheckResult[] = [...gitInfo(requireClean)];
  for (const result of results) {
    console.log(`[ora-gate] ${result.status.toUpperCase()} ${result.id}`);
    if (result.status !== "pass" && result.output) console.log(result.output);
  }

  for (const check of relevantChecks(profile)) {
    const result = commandResult(check);
    results.push(result);
    if (failFast && result.status === "fail") break;
  }

  const finishedAt = new Date();
  const report = renderReport({ profile, results, startedAt, finishedAt });
  if (reportPath) {
    const absolute = path.resolve(repoRoot, reportPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, report, "utf-8");
    console.log(`[ora-gate] Report written to ${absolute}`);
  }

  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");
  console.log(
    `[ora-gate] Complete: pass=${results.length - failed.length - warned.length} warn=${warned.length} fail=${failed.length}`,
  );
  if (failed.length > 0) {
    console.log("[ora-gate] FAILED. Do not publish or submit TestFlight.");
    process.exitCode = 1;
  } else {
    console.log("[ora-gate] PASSED. Complete manual checklist before publish/TestFlight.");
  }
}

main().catch((err) => {
  console.error("[ora-gate] Fatal error");
  console.error(err);
  process.exitCode = 1;
});
