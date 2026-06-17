---
name: detectOraExpertiseDomain topic short-circuit
description: Why passing topic "technical"/"mobile" to detectOraExpertiseDomain forces software_engineering and skips content/header-based domains
---

`detectOraExpertiseDomain(message, topic)` in `expertise.ts` evaluates domains in
three phases: (1) priority regulated domains (health/legal/accounting/finance),
(2) a **topic-based short-circuit**, (3) the remaining content patterns
(software_engineering, data_analysis, product/business strategy, operations, etc.).

The phase-2 short-circuit returns early:
- topic `"technical"` or `"mobile"` → `software_engineering`
- `"app-planning"` → `product_strategy`
- `"saas"/"ecommerce"/"pricing"` → `business_strategy`
- etc.

**Rule:** when you want filename/headers/content to drive the domain (e.g. framing
an uploaded dataset or document), pass topic `"general"`. Passing `"technical"`
makes almost every input resolve to `software_engineering` before any
data/operations/business pattern is ever tested.

**Why:** the dataset-analysis route originally passed `"technical"`, so CSV/XLSX
files with headers like `workflow`, `inventory`, `kpi`, `revenue`, `customer
segment` all got software-engineering framing. The document-analysis path
(document-prompt.ts) correctly uses `"general"`. Keep both file paths on
`"general"`.

**How to apply:** any new "detect a domain from uploaded content" call should use
`"general"`. Also note a `.csv` filename matches the `data_analysis` pattern
(via `\bcsv\b`), so CSVs sensibly default to `data_analysis`; `.xlsx` does not
match (the pattern only has `excel`), so XLSX domain is driven purely by
headers/message. Verb words like "summarize" in the message can match the
`writing` domain — stronger content domains earlier in the list win, but a truly
neutral message + neutral headers is needed to assert a `"general"` result.
