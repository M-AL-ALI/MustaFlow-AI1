---
name: Codegen drift — check direction before committing regenerated output
description: Regenerated API client files can REMOVE request fields the server actively parses; committing them silently breaks features when the spec is incomplete.
---

# Check drift direction before "fixing" a failed codegen-drift check

## The rule
When the codegen-drift check fails, diff the regenerated output against the committed files BEFORE committing the regeneration. If regeneration REMOVES a property from a request/body schema that server routes actively read (grep the route for `<Schema>.safeParse` + the field name), the openapi spec is missing that property on the input schema — the committed files are "ahead" of the spec, and regenerating would silently break the feature (zod strips unknown keys, so the flag would arrive as undefined with no error).

**Why:** A merged feature branch shipped generated files with a new boolean on the request schema, but the spec only declared it on the response schema. Local codegen "correctly" stripped it from the request zod schema; committing that would have disabled the feature in production with zero errors.

**How to apply:**
- Drift that ADDS annotations/fields = usually stale committed files; safe to regenerate.

Generated modifications after a codegen run are REPORTED AND HELD verbatim; never commit or restore generated changes without an explicit desk block.
