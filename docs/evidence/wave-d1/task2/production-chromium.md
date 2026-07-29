# Wave D.1 Task 2 - production Chromium availability

Date: 2026-07-28

## Deployment dependency

The repository already uses Replit's Nix deployment configuration. The `[nix]` section in
`.replit` now declares:

```toml
packages = ["chromium"]
```

This is the preferred deterministic deployment route. No network install or install-on-boot
fallback was added.

Replit's configuration reference defines `[nix].packages` as the list of Nix packages installed
for the app: [Replit App Configuration](https://docs.replit.com/features/project-setup/configuration).

## Executable selection

Before launching Playwright, the builder checks candidates in this order:

1. `PLAYWRIGHT_EXECUTABLE_PATH`;
2. the existing `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` compatibility variable;
3. `chromium`, `chromium-browser`, then `google-chrome` on `PATH`;
4. known Nix/Linux executable paths;
5. Playwright's bundled executable, when it exists.

Every candidate must be an executable file. The selected absolute path is passed to
`chromium.launch({ executablePath })`.

## Startup and runtime evidence

The builder starts a non-blocking availability probe when the QA module loads. Production logs now
say either:

```text
builder-qa: Chromium browser found at startup
```

or:

```text
builder-qa: Chromium browser not found at startup; QA will be deferred
```

Each QA run repeats the executable check before launch and logs the selected source and path.

If no executable is available, the existing `qa_step` channel receives:

```text
Error: QA runner failed: no Chromium binary available; QA deferred
```

The QA result is non-passing but remains non-fatal to the build, matching the existing builder
contract. No install is attempted, no build exception escapes, and the infrastructure error wording
continues to be excluded from preview self-healing.

## Automated evidence

- Resolver tests cover explicit env selection, Nix `PATH` discovery, executable validation, a
  bounded missing-browser result, and the deployment package declaration.
- Headless QA tests assert that the resolved absolute path reaches Playwright.
- The unavailable-browser test asserts that Playwright is not launched and QA returns the
  non-fatal deferred observation.
- Resolver, QA tape, and preview self-heal tests: 11 passed.
- API TypeScript: passed.
- ESLint on all changed TypeScript files: passed.
- `git diff --check`: passed.
