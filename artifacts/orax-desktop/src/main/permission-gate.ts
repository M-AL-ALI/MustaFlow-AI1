/**
 * Orax Desktop — Phase 2F local permission gate.
 *
 * Mirrors the backend command safety classifier so the desktop can
 * independently re-validate a command before executing it.
 * A compromised backend cannot force execution of arbitrary commands.
 */

// ── Local allowlist (must match backend classifier) ─────────────────────────

const ALLOWED_EXACT = new Set([
  "node --version",
  "npm --version",
  "pnpm --version",
  "git --version",
  "pwd",
  "dir /b",
  "Get-ChildItem -Name",
]);

const ALLOWED_PATTERNS: RegExp[] = [
  /^echo [ -~]{1,200}$/, // echo <printable ASCII text>
];

// ── Local blocklist ─────────────────────────────────────────────────────────

const BLOCKED_PATTERNS: RegExp[] = [
  // Command chaining / injection
  /&&|\|\||;|\||>>?|<<|`|\$\(/,
  // Destructive
  /\b(rm|del|rmdir|Remove-Item|format)\b/i,
  // Secrets / env
  /\.env/i,
  /\bGet-Content\b/i,
  /\bcat\b/i,
  // Network
  /\bcurl\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bwget\b/i,
  // Package install
  /\bnpm\s+install\b/i,
  /\bnpm\s+i\b/i,
  /\bpnpm\s+add\b/i,
  /\byarn\s+add\b/i,
  // Git write
  /\bgit\s+push\b/i,
  /\bgit\s+commit\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+clean\b/i,
  // System
  /\b(shutdown|reboot|restart|halt|poweroff)\b/i,
  // Encoding / obfuscation
  /-EncodedCommand/i,
  /\bbase64\b/i,
  // Database
  /\b(psql|mysql|sqlite3|mongosh|redis-cli)\b/i,
];

// ── Gate function ────────────────────────────────────────────────────────────

export interface GateResult {
  permitted: boolean;
  reason: string;
}

export function isCommandPermitted(command: string): GateResult {
  const trimmed = command.trim();

  if (!trimmed) {
    return { permitted: false, reason: "Empty command" };
  }

  for (const re of BLOCKED_PATTERNS) {
    if (re.test(trimmed)) {
      return { permitted: false, reason: "Command contains a blocked pattern" };
    }
  }

  if (ALLOWED_EXACT.has(trimmed)) {
    return { permitted: true, reason: "OK" };
  }

  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { permitted: true, reason: "OK" };
    }
  }

  return { permitted: false, reason: "Command is not in the local allowlist" };
}
