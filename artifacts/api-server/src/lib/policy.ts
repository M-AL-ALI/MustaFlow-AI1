/**
 * Command + package install policy for the agentic builder loop.
 *
 * Replaces the old tight per-stack allow-list with a typed, layered policy:
 *
 *   - "safe"        — legacy whitelist behaviour (read-only inspectors + the
 *                     stack's declared install/check argvs only). For locked-
 *                     down or untrusted projects.
 *   - "standard"    — broad allow with a deny-list. Any binary not in the
 *                     deny-list may run; package installs go through
 *                     `pkg_install` (which enforces a manager whitelist).
 *                     Shell metacharacters that enable command chaining /
 *                     substitution / redirection are still rejected.
 *   - "permissive"  — same as standard but skips the egress allowlist check
 *                     on `pkg_install`. Admin-set only — for trusted internal
 *                     projects that need private registries.
 *
 * Container hardening (resource caps, read-only rootfs, egress allowlist)
 * lives in container.ts — this module is purely the in-process gate that
 * runs before any shell or install request reaches Fly.
 */

export const POLICY_STRICTNESS_VALUES = ["safe", "standard", "permissive"] as const;
export type PolicyStrictness = (typeof POLICY_STRICTNESS_VALUES)[number];

export const DEFAULT_POLICY_STRICTNESS: PolicyStrictness = "standard";

/** Maximum bytes of combined stdout+stderr returned to the model per call. */
export const PER_CALL_STDOUT_CAP = 8_000;
/** Per-command timeout cap (ms) the model may request. */
export const PER_CALL_TIMEOUT_CAP_MS = 5 * 60_000;
/** Default per-command timeout (ms) when the model doesn't ask for one. */
export const PER_CALL_TIMEOUT_DEFAULT_MS = 2 * 60_000;
/** Wall-clock cap for `pkg_install` invocations (ms). */
export const PKG_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Maximum bytes accepted for a single tool input value (e.g. package name). */
export const MAX_PKG_FIELD_LEN = 128;

/**
 * Hard deny-list — substring scan, case-insensitive. Applied to the joined
 * argv string. Covers:
 *   - destructive disk / system ops
 *   - raw network sockets / shells
 *   - shell-eval flags that smuggle scripts through whitelisted runtimes
 *
 * Applied in BOTH the `safe` and `standard` profiles. `permissive` also runs
 * this — the deny-list is the floor.
 */
export const COMMAND_DENY_PATTERNS: ReadonlyArray<string> = [
  // Destructive disk / system ops
  "rm -rf /",
  "rm -rf /*",
  "rm -rf --no-preserve-root",
  "mkfs",
  "dd ",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
  // Fork bomb
  ":(){",
  // Privilege escalation
  "sudo",
  "su ",
  "doas ",
  // System file tampering
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "chmod -R 777",
  "chown -R",
  // Network exfil / raw sockets / tunneling
  "nc ",
  "ncat ",
  "netcat ",
  "telnet ",
  "socat ",
  "ftp ",
  "ssh ",
  "scp ",
  "rsync ",
  // Firewall tampering
  "iptables",
  "ip6tables",
  "ufw ",
  // Curl-piped-to-shell (the classic supply-chain footgun)
  "curl ", // curl by itself is also blocked — agent must use pkg_install
  "wget ",
  "curl\t",
  "wget\t",
  "| sh",
  "| bash",
  "|sh",
  "|bash",
  // Process control that could orphan or kill the loop
  "kill -9 1",
  "killall -9",
];

/**
 * Command-aware inline-eval block. Substring scans for `-e`/`-p`/`--eval` were
 * too broad (they hit `grep -e`, `mkdir -p`, etc.); instead, only block these
 * flags when paired with a known scripting runtime as argv[0]. Applied in
 * every strictness mode — these flags let a runtime smuggle arbitrary code
 * past the rest of the policy.
 */
const INLINE_EVAL_RUNTIMES = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
]);
const INLINE_EVAL_FLAGS = new Set(["-e", "--eval", "-c", "--exec", "-p", "--print"]);

function findInlineEvalReason(argv: string[]): string | null {
  if (argv.length < 2) return null;
  const head = (argv[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (!INLINE_EVAL_RUNTIMES.has(head)) return null;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (INLINE_EVAL_FLAGS.has(tok)) {
      return `inline code-eval flag '${tok}' on '${head}' is not allowed (use write_file + run_command on a script instead)`;
    }
  }
  return null;
}

/**
 * Shell-metacharacters that enable chaining / substitution / redirection.
 * If an `sh -lc`/`bash -c` payload contains any of these, the command is
 * rejected (except when it exactly matches the stack's declared install /
 * check argv — those are vetted source-controlled commands).
 */
export const SHELL_METACHAR_RE = /[;&|`<>]|\$\(/;

/** Read-only inspectors always allowed (even in `safe` mode). */
export const READ_ONLY_INSPECTORS: ReadonlySet<string> = new Set([
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
  "stat",
  "file",
  "true",
  "false",
  "env",
  "which",
  "whoami",
]);

/**
 * Package managers `pkg_install` understands. The first array element is the
 * argv used inside the container; `{pkg}` is replaced verbatim (already
 * sanitized) and a version suffix is appended via the manager's syntax.
 */
export type PkgManager = "npm" | "pnpm" | "yarn" | "pip";

export const PKG_MANAGER_VALUES: ReadonlyArray<PkgManager> = ["npm", "pnpm", "yarn", "pip"];

/**
 * Egress allowlist — package registries + common code hosts. `pkg_install`
 * pins the install command to a manager whose registry endpoint is in this
 * list. We don't (yet) enforce this at the Fly egress layer; the goal here
 * is to keep `pkg_install` from being used to reach arbitrary hosts.
 */
export const EGRESS_ALLOWLIST: ReadonlyArray<string> = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lc(s: string): string {
  return s.toLowerCase();
}

/** Returns the deny-list reason if argv matches, else null. */
export function findDenyReason(argv: string[]): string | null {
  const joined = " " + argv.join(" ") + " ";
  const lower = lc(joined);
  for (const bad of COMMAND_DENY_PATTERNS) {
    if (lower.includes(lc(bad))) return `blocked pattern: ${bad.trim()}`;
  }
  const inlineEval = findInlineEvalReason(argv);
  if (inlineEval) return inlineEval;
  return null;
}

/** Sanitize a package name. Returns null if invalid. */
export function sanitizePackageName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_PKG_FIELD_LEN) return null;
  // npm scoped: @scope/name; pypi: letters/digits/._-; allow extras like name[extra]
  if (!/^[@A-Za-z0-9][A-Za-z0-9._/\-[\]]*$/.test(t)) return null;
  if (t.includes("..")) return null;
  return t;
}

/** Sanitize a version spec. Returns null if invalid. */
export function sanitizeVersionSpec(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length > MAX_PKG_FIELD_LEN) return null;
  // Allow semver ranges, pip specifiers, exact, "latest", git+https URLs to allowed hosts.
  if (/[;&|`$<>()\n\r\t\\"']/.test(t)) return null;
  return t;
}

/**
 * Decide whether an argv may be executed under a given policy strictness.
 *
 * `stackContext.allowedExactArgvs` and `installCmd` are the source-controlled
 * commands declared in the stack's CheckProfile — they're always allowed
 * regardless of strictness, including when they contain shell metachars.
 */
/**
 * Extract every http(s) host referenced in the argv tokens. Used by the
 * software-level egress check below — destructive network tools are already
 * deny-listed; this catches the case where a permitted binary (e.g. `node`,
 * `pip`, the model's own `run_command`) embeds a URL pointing to a host
 * outside the allowlist.
 */
export function extractHostsFromArgv(argv: string[]): string[] {
  const hosts: string[] = [];
  const re = /\b(?:https?|git\+https?):\/\/([^/\s"'`]+)/gi;
  for (const tok of argv) {
    if (typeof tok !== "string") continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(tok)) !== null) {
      const hostPort = m[1] ?? "";
      const host = hostPort.split("@").pop() ?? hostPort; // strip userinfo
      const bareHost = host.split(":")[0] ?? host;
      if (bareHost) hosts.push(bareHost.toLowerCase());
    }
  }
  return hosts;
}

/** Returns true when `host` matches any allowlist entry (exact or subdomain). */
export function isHostAllowlisted(host: string): boolean {
  const h = host.toLowerCase();
  return EGRESS_ALLOWLIST.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

export function evaluateRunCommand(
  argv: string[],
  strictness: PolicyStrictness,
  stackContext: {
    allowedExactArgvs: string[][];
    installCmd: string[] | null;
  },
): { ok: true } | { ok: false; reason: string; blocked: true } {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: "empty argv", blocked: true };
  }
  const deny = findDenyReason(argv);
  if (deny) return { ok: false, reason: deny, blocked: true };

  // Software-level egress allowlist: in safe/standard modes, reject any
  // explicit URL in argv whose host isn't on EGRESS_ALLOWLIST. Permissive
  // mode skips this check so trusted internal projects can hit private
  // hosts (deny-list still applies). This is enforced in-process; a true
  // network-level allowlist is a separate infra task.
  if (strictness !== "permissive") {
    for (const host of extractHostsFromArgv(argv)) {
      if (!isHostAllowlisted(host)) {
        return {
          ok: false,
          reason: `egress allowlist: host '${host}' is not approved (allowlist: ${EGRESS_ALLOWLIST.join(", ")})`,
          blocked: true,
        };
      }
    }
  }

  const first = lc(argv[0] ?? "");
  const isShellWrapper = (first === "sh" || first === "bash") && argv.length >= 3;

  // Source-controlled vetted commands bypass remaining gates.
  if (isExactDeclared(argv, stackContext)) return { ok: true };

  if (isShellWrapper) {
    const inner = (argv[argv.length - 1] ?? "").trim();
    if (inner.length === 0) return { ok: false, reason: "empty shell command", blocked: true };
    if (SHELL_METACHAR_RE.test(inner)) {
      return {
        ok: false,
        reason: "shell chaining/substitution not allowed in ad-hoc commands",
        blocked: true,
      };
    }
    const innerHead = lc(inner.split(/\s+/)[0] ?? "");
    return checkBinaryHead(innerHead, strictness);
  }

  const head = lc((first.split("/").pop() ?? "").trim());
  return checkBinaryHead(head, strictness);
}

function isExactDeclared(
  argv: string[],
  ctx: { allowedExactArgvs: string[][]; installCmd: string[] | null },
): boolean {
  const sameArgv = (a: string[], b: string[]) =>
    a.length === b.length && a.every((tok, i) => tok === b[i]);
  if (ctx.installCmd && sameArgv(argv, ctx.installCmd)) return true;
  return ctx.allowedExactArgvs.some((d) => sameArgv(argv, d));
}

function checkBinaryHead(
  head: string,
  strictness: PolicyStrictness,
): { ok: true } | { ok: false; reason: string; blocked: true } {
  if (head.length === 0) {
    return { ok: false, reason: "empty binary name", blocked: true };
  }
  if (READ_ONLY_INSPECTORS.has(head)) return { ok: true };

  if (strictness === "safe") {
    return {
      ok: false,
      reason:
        "safe mode — only read-only inspectors or declared stack commands are allowed. Switch policyStrictness to 'standard' to run additional binaries.",
      blocked: true,
    };
  }

  // standard / permissive: any binary not deny-listed (already checked) is OK.
  return { ok: true };
}

/**
 * Decide whether a `pkg_install` call is allowed.
 *
 * - Manager must be one of PKG_MANAGER_VALUES.
 * - Package + version pass sanitization.
 * - Indirect: deny-list scan of the synthesized argv.
 * - permissive mode keeps the deny-list but skips the registry allowlist
 *   (e.g. for projects pointed at a private registry).
 */
export function evaluatePkgInstall(
  input: { manager: unknown; pkg: unknown; version?: unknown },
  strictness: PolicyStrictness,
):
  | { ok: true; manager: PkgManager; pkg: string; version: string; argv: string[] }
  | { ok: false; reason: string; blocked: true } {
  const mgr =
    typeof input.manager === "string" ? (input.manager.toLowerCase() as PkgManager) : null;
  if (!mgr || !(PKG_MANAGER_VALUES as readonly string[]).includes(mgr)) {
    return {
      ok: false,
      reason: `unknown package manager: ${String(input.manager)}`,
      blocked: true,
    };
  }
  const pkg = sanitizePackageName(input.pkg);
  if (!pkg) return { ok: false, reason: "invalid package name", blocked: true };
  const versionRaw = sanitizeVersionSpec(input.version);
  if (versionRaw === null) return { ok: false, reason: "invalid version spec", blocked: true };

  const argv = buildPkgInstallArgv(mgr, pkg, versionRaw);
  const deny = findDenyReason(argv);
  if (deny) return { ok: false, reason: deny, blocked: true };

  // Registry / egress allowlist enforcement. `standard` and `safe` modes only
  // permit:
  //   - bare names / version specs (manager defaults to its public registry,
  //     which is itself on the allowlist by virtue of being the manager's
  //     baked-in default)
  //   - URL-bearing specs (git+https://, https://...) whose host is on
  //     EGRESS_ALLOWLIST
  //   - pip extras-index URLs that resolve to allowlisted hosts (rejected
  //     by the URL host scan)
  //
  // `permissive` skips the host check so trusted internal projects can install
  // from private registries / mirrors. The deny-list still applies.
  if (strictness !== "permissive") {
    const hosts = [...extractHostsFromArgv([pkg]), ...extractHostsFromArgv([versionRaw])];
    for (const host of hosts) {
      if (!isHostAllowlisted(host)) {
        return {
          ok: false,
          reason: `pkg_install egress allowlist: host '${host}' is not approved (allowlist: ${EGRESS_ALLOWLIST.join(", ")}); switch policyStrictness to 'permissive' to allow private registries.`,
          blocked: true,
        };
      }
    }
  }

  return { ok: true, manager: mgr, pkg, version: versionRaw, argv };
}

function buildPkgInstallArgv(mgr: PkgManager, pkg: string, version: string): string[] {
  const spec = version ? (mgr === "pip" ? `${pkg}==${version}` : `${pkg}@${version}`) : pkg;
  switch (mgr) {
    case "npm":
      return ["npm", "install", "--no-audit", "--no-fund", "--save", spec];
    case "pnpm":
      return ["pnpm", "add", spec];
    case "yarn":
      return ["yarn", "add", spec];
    case "pip":
      return ["pip", "install", "--no-cache-dir", spec];
  }
}

export function isPolicyStrictness(v: unknown): v is PolicyStrictness {
  return typeof v === "string" && (POLICY_STRICTNESS_VALUES as readonly string[]).includes(v);
}
