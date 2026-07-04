---
name: Wiring test safety-comment substring trap
description: Safety-gate files that document forbidden patterns in their own comments will fail toContain() negation checks.
---

A "safe" utility module often documents what it avoids in a header comment:

```
* No files are written. No shell commands. No exec/spawn/shell:true.
```

The wiring test for that module then checks:

```ts
expect(src).not.toContain("shell:true");
```

The comment itself satisfies the test's forbidden pattern, causing a false positive failure.

**Why:** The test is meant to guard against accidental real subprocess invocations in production code, but the substring check is too broad — it matches comments too.

**How to apply:**
- In safety-gate module headers, write `"shell execution"` or `"shell: true"` (with a space) instead of the exact forbidden string `"shell:true"` (no space).
- Alternatively, use a more precise regex in the test that requires the pattern to appear outside a comment (`^[^*].*shell:true` etc.), but the simpler fix is to rephrase the comment.
- Same trap applies to any forbidden substring: `exec(`, `spawn(`, `eval(` — avoid documenting the exact string verbatim.
