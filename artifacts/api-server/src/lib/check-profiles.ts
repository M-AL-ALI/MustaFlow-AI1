/**
 * Per-stack check profiles for the agentic builder loop.
 *
 * Each profile describes the commands the agent should run inside the project's
 * container (or in-process, for `static-html`) to validate the generated code.
 * The agent loop consults the profile when deciding which `run_command` calls
 * are sensible — and the post-loop "checks" stage runs them automatically to
 * produce the structured CheckResult[] returned in the TaskReport.
 *
 * Stacks intentionally mirror the dispatch in `jobs.ts` (project.kind /
 * project.projectFormat / project.stack).
 */

export type StackId =
  | "static-html"
  | "react-vite"
  | "node-api"
  | "nextjs"
  | "python-flask"
  | "python-fastapi"
  | "mobile-cross";

export type CheckSpec = {
  /** Unique check id, e.g. "typecheck". */
  id: string;
  /** Human label shown in narration + reports. */
  label: string;
  /** Argv to execute. `runner` is "container" (Fly exec) or "inprocess". */
  argv: string[];
  /** Where to run. "inprocess" means the agent-loop's in-memory validator handles it. */
  runner: "container" | "inprocess";
  /** If true, a non-zero exit fails the build (else it's a warning only). */
  required: boolean;
  /** Soft timeout in ms. */
  timeoutMs: number;
};

export type CheckProfile = {
  stack: StackId;
  installCmd: string[] | null;
  checks: CheckSpec[];
};

const FIVE_MIN = 5 * 60_000;
const TWO_MIN = 2 * 60_000;
const ONE_MIN = 60_000;

export const CHECK_PROFILES: Record<StackId, CheckProfile> = {
  "static-html": {
    stack: "static-html",
    installCmd: null,
    checks: [
      {
        id: "html-syntax",
        label: "HTML / JS syntax",
        argv: ["__inprocess__", "html-syntax"],
        runner: "inprocess",
        required: true,
        timeoutMs: 30_000,
      },
      {
        id: "cross-file",
        label: "Cross-file consistency",
        argv: ["__inprocess__", "cross-file"],
        runner: "inprocess",
        required: false,
        timeoutMs: 30_000,
      },
    ],
  },
  "react-vite": {
    stack: "react-vite",
    // Note: Fly Machine exec API ignores `cwd` — all commands start from `/`.
    // We must explicitly `cd /app` so npm finds package.json in /app.
    installCmd: ["sh", "-c", "cd /app && npm install --no-audit --no-fund --prefer-offline"],
    checks: [
      {
        id: "typecheck",
        label: "TypeScript typecheck",
        argv: ["sh", "-c", "cd /app && npx --yes --package typescript tsc --noEmit"],
        runner: "container",
        required: true,
        timeoutMs: TWO_MIN,
      },
      {
        id: "build",
        label: "Vite production build",
        argv: ["sh", "-c", "cd /app && npx --yes vite build"],
        runner: "container",
        required: true,
        timeoutMs: FIVE_MIN,
      },
    ],
  },
  "node-api": {
    stack: "node-api",
    installCmd: ["sh", "-c", "cd /app && npm install --no-audit --no-fund --prefer-offline"],
    checks: [
      {
        id: "typecheck",
        label: "TypeScript typecheck",
        argv: ["sh", "-c", "cd /app && npx --yes --package typescript tsc --noEmit"],
        runner: "container",
        required: true,
        timeoutMs: TWO_MIN,
      },
      {
        id: "node-syntax",
        label: "Node syntax check (entry)",
        argv: ["sh", "-c", "cd /app && node --check index.js"],
        runner: "container",
        required: false,
        timeoutMs: ONE_MIN,
      },
    ],
  },
  nextjs: {
    stack: "nextjs",
    installCmd: ["sh", "-c", "cd /app && npm install --no-audit --no-fund --prefer-offline"],
    checks: [
      {
        id: "typecheck",
        label: "TypeScript typecheck",
        argv: ["sh", "-c", "cd /app && npx --yes --package typescript tsc --noEmit"],
        runner: "container",
        required: true,
        timeoutMs: TWO_MIN,
      },
      {
        id: "build",
        label: "Next.js build",
        argv: ["sh", "-c", "cd /app && npx --yes next build"],
        runner: "container",
        required: true,
        timeoutMs: FIVE_MIN,
      },
    ],
  },
  "python-flask": {
    stack: "python-flask",
    installCmd: [
      "sh",
      "-c",
      "cd /app && pip install --quiet --no-cache-dir -r requirements.txt 2>/dev/null || true",
    ],
    checks: [
      {
        id: "py-compile",
        label: "Python compile",
        argv: ["sh", "-c", "cd /app && python -m compileall -q . 2>&1 | tail -n 100"],
        runner: "container",
        required: true,
        timeoutMs: TWO_MIN,
      },
    ],
  },
  "python-fastapi": {
    stack: "python-fastapi",
    installCmd: [
      "sh",
      "-c",
      "cd /app && pip install --quiet --no-cache-dir -r requirements.txt 2>/dev/null || true",
    ],
    checks: [
      {
        id: "py-compile",
        label: "Python compile",
        argv: ["sh", "-c", "cd /app && python -m compileall -q . 2>&1 | tail -n 100"],
        runner: "container",
        required: true,
        timeoutMs: TWO_MIN,
      },
    ],
  },
  "mobile-cross": {
    stack: "mobile-cross",
    installCmd: null,
    checks: [
      {
        id: "mobile-structure",
        label: "Expo project structure",
        argv: ["__inprocess__", "mobile-structure"],
        runner: "inprocess",
        required: true,
        timeoutMs: 30_000,
      },
    ],
  },
};

export function resolveStackId(
  projectKind: string,
  projectFormat: string | null | undefined,
  stack: string | null | undefined,
): StackId {
  if (["mobile-ios", "mobile-android", "mobile-cross"].includes(projectKind)) {
    return "mobile-cross";
  }
  if (stack === "nextjs") return "nextjs";
  if (stack === "node-api") return "node-api";
  if (stack === "python-flask") return "python-flask";
  if (stack === "python-fastapi") return "python-fastapi";
  if (projectFormat === "react-vite") return "react-vite";
  return "static-html";
}

/** Commands the agent is allowed to run via `run_command` (substring whitelist). */
export const RUN_COMMAND_WHITELIST: ReadonlyArray<string> = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "wc",
  "echo",
  "pwd",
  "node",
  "npm",
  "npx",
  "tsc",
  "vite",
  "next",
  "python",
  "python3",
  "pip",
  "pip3",
  "expo",
  "eslint",
  "prettier",
  "true",
  "false",
];

/**
 * Commands the agent is explicitly forbidden from running.
 *
 * Includes both destructive ops AND network/exfiltration patterns. Note that
 * `node` / `python` are on the whitelist for legitimate checks (node --check,
 * python -m compileall) — but inline code-eval flags (`-e`, `-c`, `--eval`,
 * `--print`) are blocked here so the agent can't smuggle arbitrary scripts that
 * issue outbound network calls.
 */
export const RUN_COMMAND_BLOCKLIST: ReadonlyArray<string> = [
  "rm -rf /",
  "mkfs",
  "dd ",
  "shutdown",
  "reboot",
  "halt",
  "curl ",
  "wget ",
  "curl\t",
  "wget\t",
  "ssh ",
  "scp ",
  "iptables",
  "sudo",
  "su ",
  ":(){",
  "/etc/passwd",
  // Network exfiltration via raw sockets / tunneling tools
  "nc ",
  "ncat ",
  "netcat ",
  "telnet ",
  "socat ",
  "ftp ",
  // Inline code-eval flags — block arbitrary scripts via node/python
  " -e ",
  " --eval ",
  " --exec ",
  " -p ",
  " --print ",
  "python -c ",
  "python3 -c ",
];
