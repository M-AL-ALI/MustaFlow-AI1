---
name: EAS iOS build — AppCheckCore modular headers fix
description: How to fix "AppCheckCore depends upon GoogleUtilities/RecaptchaInterop which do not define modules" during pod install in EAS builds
---

# The Error

```
[!] The following Swift pods cannot yet be integrated as static libraries:
The Swift pod `AppCheckCore` depends upon `GoogleUtilities` and `RecaptchaInterop`,
which do not define modules.
```

Triggered by `@clerk/expo` pulling in `GoogleSignIn` → `AppCheckCore` (Swift) which needs modular headers.

# The Fix

In an `@expo/config-plugins` `withDangerousMod` plugin, insert `use_modular_headers!` **before** `install! 'cocoapods'` in the Podfile:

```js
contents = contents.replace("install! 'cocoapods'", "use_modular_headers!\n\ninstall! 'cocoapods'");
```

**Why:** `use_modular_headers!` globally enables module maps for all pods. The error message itself prescribes this fix. Earlier attempts with `pod 'GoogleUtilities', :modular_headers => true` at the end of the target block were not effective.

**How to apply:** Any Expo project using `@clerk/expo` with GoogleSignIn.

# Plugin Dependency Rule

`@expo/config-plugins` must be a **direct** devDependency of the artifact package (not just transitive). pnpm strict isolation means transitive deps are not resolvable from a plugin file via `require('@expo/config-plugins')`. Add it explicitly and run `pnpm install --lockfile-only` to update the lockfile for EAS.

# EAS Runs pnpm install --no-frozen-lockfile from Workspace Root

EAS detects pnpm workspaces and installs all workspace packages from the root. This means the updated lockfile with direct deps will be honoured.
