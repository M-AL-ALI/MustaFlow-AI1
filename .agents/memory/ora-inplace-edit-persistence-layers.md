---
name: Ora in-place edit persistence layers
description: Every real in-place Office edit must update ALL persistence layers or post-restart revisions silently revert to the original upload.
---

Rule: a real in-place Office edit (PPTX/DOCX/XLSX revise) has THREE persistence layers that must stay in sync — the in-memory session file entry (write-back of edited bytes + re-extracted text), the asset library (persist edited result), and the durable file-context mirror row (must be repointed at the NEW assetId with the post-edit extracted text).

**Why:** The durable mirror rehydrates raw bytes by assetId after a server restart or session rotation. If it still points at the original upload's asset, the next "revise" quietly compounds on pre-edit bytes and earlier edits vanish — a silent-regeneration-class bug that no single-session test catches.

**How to apply:** When an edit engine writes back edited bytes, mark the result with a server-internal marker (e.g. `editedFileRef`, never serialized to the client) only when write-back truly succeeded; routes that persist the asset then call the relink helper in file-context-store with the new assetId. Passthrough (unchanged) results must NOT get the marker. Any NEW route or code path that produces an in-place-edited file result needs the same persist + relink pairing.

Known gap (accepted): xlsx write-back does not re-extract text, so the durable row keeps pre-edit extractedText/datasetSummary next to correct edited bytes — post-restart *analysis* answers about an edited xlsx may be stale even though edits compound correctly.
