/**
 * Orax Desktop — Phase 2F command safety classifier.
 *
 * Classifies a command as allowed/blocked before an approval is created.
 * The desktop permission gate mirrors this list and re-validates locally
 * before execution, so the backend and desktop are independently safe.
 */

export interface CommandClassification {
  allowed: boolean;
  risk: "low" | "medium" | "high" | "blocked";
  reason: string;
  normalizedCommand: string;
}

// ── Exact-match allowlist ───────────────────────────────────────────────────

const ALLOWED_EXACT = new Set([
  "node --version",
  "npm --version",
  "pnpm --version",
  "git --version",
  "pwd",
  "dir /b",
  "Get-ChildItem -Name",
]);

// ── Pattern allowlist (narrow safe patterns only) ──────────────────────────

const ALLOWED_PATTERNS: RegExp[] = [
  /^echo [ -~]{1,200}$/, // echo <printable ASCII text>
];

// ── Block rules (checked before allowlist) ─────────────────────────────────

interface BlockRule {
  pattern: RegExp;
  reason: string;
  risk: "blocked" | "high";
}

const BLOCK_RULES: BlockRule[] = [
  // Command chaining / shell injection
  {
    pattern: /&&|\|\||;|\||>>?|<<|`|\$\(/,
    reason: "Command chaining is not allowed",
    risk: "blocked",
  },
  // Destructive file operations
  {
    pattern: /\b(rm|del|rmdir|Remove-Item|format)\b/i,
    reason: "Destructive file operations are not allowed",
    risk: "blocked",
  },
  // Secret / env file reading
  {
    pattern: /\.env/i,
    reason: "Reading .env files is not allowed",
    risk: "blocked",
  },
  {
    pattern: /\bGet-Content\b/i,
    reason: "Get-Content is not allowed",
    risk: "blocked",
  },
  {
    pattern: /\bcat\b/i,
    reason: "cat is not allowed",
    risk: "blocked",
  },
  {
    pattern: /\btype\s+.*\.(env|key|pem|p12|pfx)/i,
    reason: "Reading credential files is not allowed",
    risk: "blocked",
  },
  // Network commands
  {
    pattern: /\bcurl\b/i,
    reason: "Network commands are not allowed",
    risk: "blocked",
  },
  {
    pattern: /\bInvoke-WebRequest\b/i,
    reason: "Network commands are not allowed",
    risk: "blocked",
  },
  {
    pattern: /\bwget\b/i,
    reason: "Network commands are not allowed",
    risk: "blocked",
  },
  {
    pattern: /\bfetch\b/i,
    reason: "Network commands are not allowed",
    risk: "blocked",
  },
  // Package install (Phase 2F restriction)
  {
    pattern: /\bnpm\s+install\b/i,
    reason: "Package installation is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\bnpm\s+i\b/i,
    reason: "Package installation is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\bpnpm\s+add\b/i,
    reason: "Package installation is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\byarn\s+add\b/i,
    reason: "Package installation is not allowed in Phase 2F",
    risk: "blocked",
  },
  // Git write operations (Phase 2F restriction)
  {
    pattern: /\bgit\s+push\b/i,
    reason: "git push is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\bgit\s+commit\b/i,
    reason: "git commit is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\bgit\s+reset\b/i,
    reason: "git reset is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\bgit\s+clean\b/i,
    reason: "git clean is not allowed in Phase 2F",
    risk: "blocked",
  },
  {
    pattern: /\bgit\s+rebase\b/i,
    reason: "git rebase is not allowed in Phase 2F",
    risk: "blocked",
  },
  // Shell spawning / interpreter bypass
  {
    pattern: /\b(powershell|pwsh|cmd\.exe|bash|sh|zsh|fish|ksh|csh|tcsh|dash)\b/i,
    reason: "Shell spawning is not allowed",
    risk: "blocked",
  },
  // System control
  {
    pattern: /\b(shutdown|reboot|restart|halt|poweroff)\b/i,
    reason: "System control commands are not allowed",
    risk: "blocked",
  },
  // Encoded / obfuscated commands
  {
    pattern: /-EncodedCommand/i,
    reason: "Encoded commands are not allowed",
    risk: "blocked",
  },
  {
    pattern: /\bbase64\b/i,
    reason: "base64 decode/encode commands are not allowed",
    risk: "blocked",
  },
  // Database CLIs
  {
    pattern: /\b(psql|mysql|sqlite3|mongosh|redis-cli)\b/i,
    reason: "Database CLI commands are not allowed",
    risk: "blocked",
  },
  // Environment variable dumps
  {
    pattern: /\b(printenv|env|set)\s*$/i,
    reason: "Environment variable dumps are not allowed",
    risk: "blocked",
  },
];

// ── Classifier ─────────────────────────────────────────────────────────────

export function classifyOraxCommand(command: string): CommandClassification {
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    return {
      allowed: false,
      risk: "blocked",
      reason: "Empty command",
      normalizedCommand: "",
    };
  }

  // Check block rules first
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return {
        allowed: false,
        risk: rule.risk,
        reason: rule.reason,
        normalizedCommand,
      };
    }
  }

  // Check exact allowlist
  if (ALLOWED_EXACT.has(normalizedCommand)) {
    return {
      allowed: true,
      risk: "low",
      reason: "Command is in the safe allowlist",
      normalizedCommand,
    };
  }

  // Check pattern allowlist
  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(normalizedCommand)) {
      return {
        allowed: true,
        risk: "low",
        reason: "Command matches a safe pattern",
        normalizedCommand,
      };
    }
  }

  // Anything else is not in the allowlist
  return {
    allowed: false,
    risk: "high",
    reason: "Command is not in the Phase 2F allowlist",
    normalizedCommand,
  };
}
