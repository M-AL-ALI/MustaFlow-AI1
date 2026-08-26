# Ruflo Safe Orchestration

Date: 2026-08-26  
Environment: lab  
Database: none  
Runtime store: `A:/NabuFlowLab/.ruflo-safe`

## Purpose

Ruflo is an optional, replaceable orchestration provider behind NabuFlow. Zero remains the only
user-facing agent and NabuFlow remains authoritative for intent, authorization, project identity,
secrets, spend, versions, evidence, and publishing.

The initial integration is deliberately read-only. It gives Codex a bounded review helper without
giving Ruflo mutation, terminal, browser, network-fetch, memory-write, provider, daemon, or publish
authority.

## Installed specimen

- Package: `ruflo`
- Version: `3.38.20`
- Implementation package: `@claude-flow/cli` `3.38.20`
- License reported by both installed package manifests: MIT
- Required runtime: Node.js 20 or newer
- The wrapper and implementation file identities are pinned in
  `scripts/src/ruflo-mcp-policy.ts`.

## Stage gates

1. **Safe lab connection.** Project-scoped Codex MCP configuration launches the NabuFlow proxy.
   The proxy pins package identity, moves state/cache/temp to A:, strips credentials, disables
   background autonomy, limits methods and arguments, and allows six read-only tools.
2. **Measured pilot.** A bounded local MCP run checks connection truth, negative authorization,
   three known risk classifications, typed review output, worktree cleanliness, and disk readings.
3. **Replaceable adapter.** `RufloReadOnlyReviewAdapter` consumes an injected transport and returns a
   version- and tree-bound receipt. Malformed upstream answers fail closed.
4. **Limited delegation.** The only authorized delegation in this first slice is branch-diff review
   through the explicit `ruflo:pilot` command. It is not automatically invoked and cannot publish.
   Customer-facing Zero delegation remains gated on a later production architecture decision.

## Allowed tools

- `mcp_status`
- `system_info`
- `analyze_diff-risk`
- `analyze_diff-classify`
- `analyze_diff-stats`
- `analyze_file-risk`

The allowlist is enforced twice: in `.codex/config.toml` and in the NabuFlow MCP proxy. Tool
advertisement alone is never treated as authorization.

## Invariants

- The Windows repository must resolve to A:.
- Ruflo runtime data remains outside the permanent worktree.
- Only a minimal environment reaches Ruflo; application/provider credentials are not forwarded.
- The daemon is disabled and no automatic retry, transcript, trajectory, browser, or private-network
  feature is enabled.
- Requests and responses are newline-framed, size-bounded, method-bounded, tool-bounded, and
  argument-bounded.
- A review success is structurally tied to a 40-hex commit and tree receipt.
- This integration does not modify a database, provider, public surface, or production deployment.

## Incidental findings and preventatives

1. Some upstream status-style tools update local metrics. Preventative: status categories are not
   broadly allowed; the exact six-tool list is test-pinned.
2. Ruflo supports automatic daemon startup. Preventative: both environment policy and the proxy set
   daemon autostart off; no project initialization is performed.
3. An advertised-tool filter is not a sufficient call authorization boundary. Preventative: the
   proxy independently rejects every unapproved `tools/call`, and the negative control invokes a
   known disallowed tool by name.
4. Windows cannot safely launch the npm command shim through the selected child-process path.
   Preventative: the proxy resolves the installed JavaScript entry, verifies three SHA-256 identities,
   and launches it with the current Node executable without a shell.
5. The repository Prettier installation has no TOML parser. Preventative: the policy test reads the
   project MCP configuration and verifies its allowlist and approval mode structurally; Prettier
   remains authoritative for the TypeScript and JSON files.

## Activation note

Official OpenAI documentation states that local Codex clients support project-scoped MCP
configuration and require the client to refresh after server configuration changes. The current
session cannot gain a newly configured MCP tool dynamically. The bounded pilot therefore proves the
same STDIO path directly; a subsequent Codex restart activates the project-scoped server in the UI.
