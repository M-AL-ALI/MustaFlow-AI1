# Wave D.1 Task 1 - sandbox XDG environment

Date: 2026-07-28

## Production failure audited

Wave D Task 0 recorded this bounded sandbox observation from production:

```text
/nix/store/17prmkcmwjif1sbpgpfb12dn94psc4gd-npx/bin/npx: line 6:
XDG_CONFIG_HOME: unbound variable
```

The wrapper named `XDG_CONFIG_HOME` as its missing prerequisite. It did not report
`XDG_CACHE_HOME`, so this hotfix adds only `XDG_CONFIG_HOME`.

## Environment behavior

`buildSandboxEnvironment(root)` now sets:

```text
XDG_CONFIG_HOME=<sandbox root>/.config
```

The directory is created when the per-task temporary root is initialized. The value is constructed
from that root and never copied from the server environment. `XDG_CACHE_HOME` remains absent, as
does every production secret and API key that was already excluded by the environment allowlist.

## Automated evidence

The sandbox test temporarily gives the host process a different `XDG_CONFIG_HOME`, then verifies:

- the child environment contains `XDG_CONFIG_HOME`;
- its value is exactly `<sandbox root>/.config`;
- its relative path from the sandbox root is `.config`;
- it is not the host value;
- `XDG_CACHE_HOME` remains unset;
- `DATABASE_URL` and `OPENAI_API_KEY` remain absent.

The real-command test executes inside the temporary snapshot with bounded output and observes
`xdg-local=true`, confirming that the directory exists at `.config` beneath the command's working
root. It also confirms that a host database secret does not reach the child.

## Verification

- Sandbox shell tests: 6 passed.
- API TypeScript: passed.
- Workspace library TypeScript: passed.
- ESLint on the changed TypeScript files: passed.
- `git diff --check`: passed.
