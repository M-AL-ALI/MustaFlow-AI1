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
        // Use local tsc if available (node_modules present), fall back to npx.
        // The `--` separator is required for npm@10 to correctly route to the
        // `typescript` package binary rather than installing a `tsc` package.
        argv: [
          "sh",
          "-c",
          "cd /app && if [ -f ./node_modules/.bin/tsc ]; then ./node_modules/.bin/tsc --noEmit; else npx --yes --package typescript -- tsc --noEmit; fi",
        ],
        runner: "container",
        // Non-required: npm install often fails with OOM (SIGKILL/137) in
        // constrained Fly machines, making tsc unreachable. A timeout here
        // must not block preview reachability — the server-start check is the
        // real gate for whether the server is actually running.
        required: false,
        timeoutMs: TWO_MIN,
      },
      {
        id: "node-syntax",
        label: "Node syntax check (entry)",
        // Detect the compiled entry from package.json `main`; skip gracefully
        // when the project uses `tsx` (no pre-compiled JS entry at check time).
        argv: [
          "sh",
          "-c",
          'cd /app && MAIN=$(node -p \'try{const p=JSON.parse(require("fs").readFileSync("package.json","utf8"));p.main||""}catch(e){""}\' 2>/dev/null); if [ -n "$MAIN" ] && [ -f "$MAIN" ]; then node --check "$MAIN"; else echo "No pre-compiled JS entry found — tsx-based server (skip)."; fi',
        ],
        runner: "container",
        required: false,
        timeoutMs: ONE_MIN,
      },
      {
        id: "server-start",
        label: "Server startup (healthz)",
        // Poll the live dev-server on port 3000 first.  If it doesn't answer,
        // try to (re-)start it via `npm run dev:server` and wait up to ~14 s.
        // This surfaces DATABASE_URL / crash errors to the agent so it can fix
        // them before calling finalize.
        argv: [
          "sh",
          "-c",
          [
            "cd /app",
            // Quick poll — server may already be running and healthy
            "CODE=$(curl -sf -o /dev/null -w '%{http_code}' http://localhost:3000/healthz 2>/dev/null || echo 000)",
            'if [ "$CODE" = "200" ]; then echo "healthz OK"; exit 0; fi',
            // Not yet healthy — (re-)start the dev server
            "pkill -f 'tsx ' 2>/dev/null || true",
            "pkill -f 'node ' 2>/dev/null || true",
            "sleep 1",
            "export PORT=3000",
            "nohup npm run dev:server >/tmp/__hc_server.log 2>&1 &",
            // Poll up to 7 × 2 s = 14 s
            "for i in 1 2 3 4 5 6 7; do",
            "  sleep 2",
            "  CODE=$(curl -sf -o /dev/null -w '%{http_code}' http://localhost:3000/healthz 2>/dev/null || echo 000)",
            '  if [ "$CODE" = "200" ]; then echo "healthz OK after restart"; exit 0; fi',
            "done",
            'echo "Server did not respond to GET /healthz within 15 s (last HTTP $CODE)"',
            "tail -50 /tmp/__hc_server.log 2>/dev/null || true",
            "exit 1",
          ].join("\n"),
        ],
        runner: "container",
        required: true,
        timeoutMs: TWO_MIN,
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
