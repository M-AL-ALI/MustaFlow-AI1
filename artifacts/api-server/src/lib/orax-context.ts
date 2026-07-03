import type { OraxGithubScanSummary } from "./orax-github";

const DOMAIN_FILE_LIMIT = 8;

export function inferOraxDomainPaths(
  prompt: string,
  sampleFiles: string[],
  topLevelEntries: Array<{ path: string; type: string }>,
): string[] {
  if (!sampleFiles.length && !topLevelEntries.length) return [];

  const lower = prompt.toLowerCase();

  const isAuth =
    /\b(auth|login|sign[\s-]?in|sign[\s-]?up|sign[\s-]?out|logout|session|credential|password|jwt|oauth|clerk|account|middleware)\b/.test(
      lower,
    );
  const isMobile =
    /\b(mobile|layout|screen|navigation|expo|react[\s-]?native|tab|component|style|theme|ui\s|scroll|swipe|stack|bottom\s*nav)\b/.test(
      lower,
    );
  const isBuild =
    /\b(build|typecheck|type\s*error|compile|package|tsconfig|vite|webpack|rollup|lint|eslint|fail|crash|broken|import\s*error|module\s*not\s*found)\b/.test(
      lower,
    );
  const isTest =
    /\b(test|spec|jest|vitest|coverage|unit[\s-]?test|e2e|playwright|test[\s-]?fail|fail[\s-]?test|failing\s*test)\b/.test(
      lower,
    );
  const isExplain =
    /\b(explain|understand|overview|how\s+.*work|what\s+.*do|describe|walk[\s-]?through|tour|guide|document)\b/.test(
      lower,
    ) ||
    /\b(review\s+(this\s+)?repo|repo.*review|repository.*overview|understand.*codebase)\b/.test(
      lower,
    );
  const isUi =
    /\b(button|color|font|spacing|css|style|theme|design|icon|visual|look|appear|render|ui\s+issue|layout\s+issue|responsive)\b/.test(
      lower,
    );
  const isApi =
    /\b(api|endpoint|route|request|response|backend|server|handler|controller|rest|graphql|webhook)\b/.test(
      lower,
    );
  const isDb =
    /\b(database|schema|migration|table|column|query|orm|drizzle|prisma|postgres|sql)\b/.test(
      lower,
    );

  const allPaths = Array.from(
    new Set([
      ...sampleFiles,
      ...topLevelEntries.filter((e) => e.type === "blob").map((e) => e.path),
    ]),
  );

  const scored: Array<[string, number]> = [];

  for (const filePath of allPaths) {
    const f = filePath.toLowerCase();
    let score = 0;

    if (isAuth) {
      if (/auth|login|sign.?in|sign.?out|logout|session|clerk|credential|middleware/.test(f))
        score += 10;
      if (/user|account/.test(f)) score += 6;
      if (/route|endpoint|api|handler/.test(f)) score += 3;
    }

    if (isMobile) {
      if (/screen|tab|navigation|nav|stack/.test(f)) score += 10;
      if (/component|style|theme|layout/.test(f)) score += 8;
      if (/app\/(home|settings|tabs|screens|main)/.test(f)) score += 9;
      if (/^app\/(?:\([^)]+\)\/)?[^/]+\.[tj]sx?$|\/screens?\//.test(f)) score += 9;
      if (/expo|react.native/.test(f)) score += 5;
    }

    if (isBuild) {
      if (/package\.json$/.test(f)) score += 12;
      if (/tsconfig/.test(f)) score += 10;
      if (/vite\.config|jest\.config|vitest\.config|eslint\.config|\.eslintrc/.test(f)) score += 10;
      if (/pnpm.lock|yarn\.lock|package-lock/.test(f)) score += 7;
      if (/src\/(index|app|main|server)\.[tj]sx?$/.test(f)) score += 5;
    }

    if (isTest) {
      if (/\.test\.[tj]sx?$|\.spec\.[tj]sx?$|__tests__/.test(f)) score += 10;
      if (/vitest\.config|jest\.config/.test(f)) score += 9;
      if (/setup\.[tj]sx?$/.test(f)) score += 5;
    }

    if (isExplain) {
      if (/readme\.md$/i.test(f)) score += 14;
      if (/package\.json$/.test(f)) score += 12;
      if (/schema|migration/.test(f)) score += 9;
      if (/db|database/.test(f)) score += 7;
      if (
        /src\/(index|app|main|server)\.[tj]sx?$|routes\/index\.[tj]s$|app\/(index|layout)\.[tj]sx?$/.test(
          f,
        )
      )
        score += 10;
    }

    if (isUi) {
      if (/style|theme|component|layout|css|tailwind/.test(f)) score += 10;
      if (/page|screen|view/.test(f)) score += 7;
    }

    if (isApi) {
      if (/route|endpoint|handler|controller|api/.test(f)) score += 10;
      if (/middleware|validator|schema/.test(f)) score += 6;
    }

    if (isDb) {
      if (/schema|migration|model|entity|drizzle|prisma/.test(f)) score += 10;
      if (/db|database/.test(f)) score += 7;
    }

    if (score > 0) scored.push([filePath, score]);
  }

  return scored
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
    .slice(0, DOMAIN_FILE_LIMIT);
}

const NL_PLAN_PHRASES: RegExp =
  /\b(plan\s+this\s+first|make\s+a\s+plan\s+first|think\s+before\s+implementing|think\s+before\s+you\s+implement|outline\s+the\s+approach|show\s+me\s+the\s+plan|plan\s+only|no\s+changes\s+yet|analyze\s+before\s+changing|review\s+first\s+then\s+plan|plan\s+first|create\s+a\s+plan\s+first|step\s+by\s+step\s+plan)\b/;

export function isNlPlanModeMessage(message: string): boolean {
  const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
  return NL_PLAN_PHRASES.test(normalized);
}

export type { OraxGithubScanSummary };
