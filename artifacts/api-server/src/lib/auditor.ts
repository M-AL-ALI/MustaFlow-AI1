/**
 * Code Quality Auditor
 * Static HTML analysis for accessibility, SEO, performance, and CDN vulnerability checks.
 * All checks are performed server-side using regex/string analysis (no DOM, no browser).
 */

import type { BuilderFile } from "./builder";
import { scanCdnUrls } from "./cdn-allowlist";

export type AuditSeverity = "error" | "warning" | "info";
export type AuditCategory = "accessibility" | "seo" | "performance" | "security";

export interface AuditFinding {
  category: AuditCategory;
  severity: AuditSeverity;
  file: string;
  message: string;
  suggestion: string;
}

export interface AuditScore {
  category: AuditCategory;
  label: string;
  pass: number;
  warnings: number;
  failures: number;
  /** 0–100 score derived from pass/(pass+warn+fail) */
  score: number;
}

export interface AuditReport {
  findings: AuditFinding[];
  scores: AuditScore[];
  auditedAt: string;
  fileCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function htmlFiles(files: BuilderFile[]): BuilderFile[] {
  return files.filter(
    (f) => f.mimeType === "text/html" || f.path.endsWith(".html"),
  );
}

/** Extract all attribute values for a given attribute name from an HTML string. */
function extractAttr(html: string, attr: string): string[] {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) results.push(m[1]);
  }
  return results;
}

/** Extract all occurrences of a tag (opening tag), returning the full opening tag string. */
function extractTags(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
  return html.match(re) ?? [];
}

/** Check if a tag string contains an attribute. */
function hasAttr(tag: string, attr: string): boolean {
  return new RegExp(`\\b${attr}\\s*=`, "i").test(tag);
}

/** Count external resource URLs from script/link/img src/href attributes. */
function countExternalResources(html: string): number {
  const scriptSrcs = extractAttr(html, "src").filter((s) =>
    s.startsWith("http://") || s.startsWith("https://") || s.startsWith("//"),
  );
  const linkHrefs = extractAttr(html, "href").filter((s) =>
    (s.startsWith("http://") || s.startsWith("https://") || s.startsWith("//")) &&
    !s.startsWith("//fonts.googleapis"), // Google Fonts doesn't count as blocking
  );
  return scriptSrcs.length + linkHrefs.length;
}

/** Extract all CDN resource URLs (script src, link href) from HTML. */
function extractCdnUrls(html: string): string[] {
  const src = extractAttr(html, "src").filter(
    (s) => s.includes("unpkg.com") || s.includes("cdn.jsdelivr.net") || s.includes("cdnjs.cloudflare.com") || s.includes("cdn.tailwindcss.com") || s.includes("cdn.skypack.dev"),
  );
  const href = extractAttr(html, "href").filter(
    (s) => s.includes("unpkg.com") || s.includes("cdn.jsdelivr.net") || s.includes("cdnjs.cloudflare.com"),
  );
  return [...src, ...href];
}

// ─── Accessibility Audit ──────────────────────────────────────────────────────

export function auditAccessibility(files: BuilderFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const htmls = htmlFiles(files);

  for (const file of htmls) {
    const html = file.content;

    // 1. Missing lang attribute on <html>
    const htmlTag = html.match(/<html(?:\s[^>]*)?>/i)?.[0] ?? "";
    if (!hasAttr(htmlTag, "lang")) {
      findings.push({
        category: "accessibility",
        severity: "error",
        file: file.path,
        message: "The <html> element is missing a lang attribute.",
        suggestion: 'Add lang="en" (or the appropriate language code) to the <html> tag to help screen readers announce the correct language.',
      });
    }

    // 2. Images without alt attribute
    const imgTags = extractTags(html, "img");
    for (const img of imgTags) {
      if (!hasAttr(img, "alt")) {
        findings.push({
          category: "accessibility",
          severity: "error",
          file: file.path,
          message: `An <img> tag is missing the alt attribute: ${img.slice(0, 80)}`,
          suggestion: 'Add alt="descriptive text" to the image. Use alt="" (empty) if the image is purely decorative.',
        });
        break; // Report once per file to avoid spamming
      }
    }

    // 3. Form inputs without associated labels
    const inputTags = html.match(/<input(?:\s[^>]*)?\/?>/gi) ?? [];
    const labelFors = extractAttr(html, "for");
    const inputIds = extractAttr(html, "id").filter((id) => {
      // Check if any input has this id
      return inputTags.some((t) => t.includes(`id="${id}"`) || t.includes(`id='${id}'`));
    });

    const unlabeledInputs = inputTags.filter((tag) => {
      const type = (tag.match(/type\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
      const idMatch = tag.match(/\bid\s*=\s*["']([^"']*)["']/i)?.[1];
      if (!idMatch) {
        // Check if wrapped in a <label> — heuristic: look for the input inside a label block
        return true;
      }
      return !labelFors.includes(idMatch);
    });

    if (unlabeledInputs.length > 0) {
      findings.push({
        category: "accessibility",
        severity: "error",
        file: file.path,
        message: `${unlabeledInputs.length} form input(s) lack an associated <label> element.`,
        suggestion: 'Add a <label for="inputId"> element for each input, or wrap inputs inside a <label> element. This is required for screen reader accessibility.',
      });
    }

    // 4. Buttons without accessible text
    const buttonTags = html.match(/<button(?:\s[^>]*)?>[\s\S]*?<\/button>/gi) ?? [];
    const iconOnlyButtons = buttonTags.filter((btn) => {
      const hasAriaLabel = /aria-label\s*=/i.test(btn);
      const hasAriaLabelledBy = /aria-labelledby\s*=/i.test(btn);
      const hasTitle = /\btitle\s*=/i.test(btn);
      const textContent = btn.replace(/<[^>]+>/g, "").trim();
      return !hasAriaLabel && !hasAriaLabelledBy && !hasTitle && textContent.length === 0;
    });

    if (iconOnlyButtons.length > 0) {
      findings.push({
        category: "accessibility",
        severity: "error",
        file: file.path,
        message: `${iconOnlyButtons.length} button(s) have no visible text or aria-label (icon-only buttons).`,
        suggestion: 'Add aria-label="Descriptive action" to icon-only buttons so screen readers can announce their purpose.',
      });
    }

    // 5. Missing skip-nav link
    const hasSkipNav =
      /<a[^>]+href\s*=\s*["']#(?:main|content|skip|maincontent)[^"']*["'][^>]*>/i.test(html);
    if (!hasSkipNav && html.includes("<nav")) {
      findings.push({
        category: "accessibility",
        severity: "warning",
        file: file.path,
        message: "No skip-navigation link found. Keyboard users cannot bypass repeated navigation.",
        suggestion: 'Add a skip link as the first element in <body>: <a href="#main-content" class="sr-only focus:not-sr-only">Skip to main content</a>. Target the <main> element with id="main-content".',
      });
    }

    // 6. Low contrast heuristic — inline style color checks
    const inlineColorStyles = html.match(/style\s*=\s*["'][^"']*color\s*:[^;'"]+/gi) ?? [];
    const suspiciousContrast = inlineColorStyles.filter((s) => {
      const lower = s.toLowerCase();
      // Flag when text color and background color appear to be both light or both dark
      const hasLightGray = lower.includes("#ccc") || lower.includes("#ddd") || lower.includes("#eee") || lower.includes("#f0f") || lower.includes("lightgray") || lower.includes("silver");
      const hasWhiteBg = lower.includes("background") && (lower.includes("#fff") || lower.includes("white"));
      return hasLightGray && !hasWhiteBg;
    });

    if (suspiciousContrast.length > 0) {
      findings.push({
        category: "accessibility",
        severity: "warning",
        file: file.path,
        message: "Potential low-contrast inline color styles detected. Text on similar-colored backgrounds may fail WCAG contrast requirements.",
        suggestion: "Ensure body text has at least 4.5:1 contrast ratio and large text has at least 3:1 contrast ratio. Use a tool like https://webaim.org/resources/contrastchecker/ to verify.",
      });
    }
  }

  return findings;
}

// ─── SEO Audit ────────────────────────────────────────────────────────────────

export function auditSeo(files: BuilderFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const htmls = htmlFiles(files);

  for (const file of htmls) {
    const html = file.content;

    // Only audit index and main pages (skip sub-pages for now)
    const isIndexPage = file.path === "index.html" || file.path.endsWith("/index.html");

    // 1. Missing or generic <title>
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) {
      findings.push({
        category: "seo",
        severity: "error",
        file: file.path,
        message: "No <title> element found.",
        suggestion: "Add a descriptive <title> tag inside <head>. It should be 50–60 characters and accurately describe the page content.",
      });
    } else {
      const titleText = titleMatch[1]?.trim() ?? "";
      const genericTitles = ["document", "untitled", "my app", "page", "app", "index", "home page", "my website", "website"];
      if (titleText.length === 0 || genericTitles.some((g) => titleText.toLowerCase() === g)) {
        findings.push({
          category: "seo",
          severity: "warning",
          file: file.path,
          message: `The <title> tag is generic or empty: "${titleText}".`,
          suggestion: "Replace the generic title with a descriptive, keyword-rich title that reflects the page's unique content.",
        });
      }
    }

    // 2. Missing meta description
    const hasMetaDescription = /<meta\s[^>]*name\s*=\s*["']description["'][^>]*>/i.test(html);
    if (!hasMetaDescription) {
      findings.push({
        category: "seo",
        severity: "error",
        file: file.path,
        message: "No <meta name=\"description\"> tag found.",
        suggestion: 'Add <meta name="description" content="A concise 150–160 character summary of this page."> inside <head>.',
      });
    }

    // 3. Missing Open Graph tags (only warn on index pages)
    if (isIndexPage) {
      const ogTitle = /<meta\s[^>]*property\s*=\s*["']og:title["'][^>]*>/i.test(html);
      const ogDesc = /<meta\s[^>]*property\s*=\s*["']og:description["'][^>]*>/i.test(html);
      const ogImage = /<meta\s[^>]*property\s*=\s*["']og:image["'][^>]*>/i.test(html);

      if (!ogTitle || !ogDesc || !ogImage) {
        const missing = [
          !ogTitle && "og:title",
          !ogDesc && "og:description",
          !ogImage && "og:image",
        ].filter(Boolean);
        findings.push({
          category: "seo",
          severity: "warning",
          file: file.path,
          message: `Missing Open Graph tags: ${missing.join(", ")}.`,
          suggestion: 'Add Open Graph meta tags inside <head> to control how the page appears when shared on social media: <meta property="og:title" content="…">, <meta property="og:description" content="…">, <meta property="og:image" content="…">.',
        });
      }
    }

    // 4. Missing canonical link
    const hasCanonical = /<link\s[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.test(html);
    if (!hasCanonical && isIndexPage) {
      findings.push({
        category: "seo",
        severity: "info",
        file: file.path,
        message: "No canonical link element found.",
        suggestion: 'Add <link rel="canonical" href="https://yourdomain.com/"> to prevent duplicate content issues if the page can be accessed via multiple URLs.',
      });
    }

    // 5. No structured data
    const hasStructuredData = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>/i.test(html);
    if (!hasStructuredData && isIndexPage) {
      findings.push({
        category: "seo",
        severity: "info",
        file: file.path,
        message: "No structured data (JSON-LD) found.",
        suggestion: 'Add <script type="application/ld+json"> with schema.org structured data to enable rich search results (e.g. WebSite, Organization, Product, Article schema).',
      });
    }
  }

  return findings;
}

// ─── Performance Audit ────────────────────────────────────────────────────────

export function auditPerformance(files: BuilderFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const htmls = htmlFiles(files);

  for (const file of htmls) {
    const html = file.content;

    // 1. Render-blocking scripts in <head> without defer/async
    const headMatch = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? "";
    const headScripts = headMatch.match(/<script(?:\s[^>]*)?\/?>/gi) ?? [];
    const blockingScripts = headScripts.filter((s) => {
      const hasSrc = hasAttr(s, "src");
      const hasDefer = /\bdefer\b/i.test(s);
      const hasAsync = /\basync\b/i.test(s);
      const hasType = s.match(/type\s*=\s*["']([^"']*)["']/i)?.[1];
      // Module scripts are deferred by default; type="text/babel" is also non-blocking in practice
      if (hasType === "module" || hasType === "text/babel" || hasType === "importmap") return false;
      return hasSrc && !hasDefer && !hasAsync;
    });

    if (blockingScripts.length > 0) {
      findings.push({
        category: "performance",
        severity: "warning",
        file: file.path,
        message: `${blockingScripts.length} render-blocking <script> tag(s) in <head> without defer or async.`,
        suggestion: 'Add the defer attribute to non-critical scripts in <head>: <script src="…" defer>. Use async for scripts with no dependencies. This prevents the browser from pausing HTML parsing to download and execute scripts.',
      });
    }

    // 2. Images without explicit width/height (layout shift risk)
    const imgTags = extractTags(html, "img");
    const imgsWithoutDimensions = imgTags.filter((img) => {
      const hasWidth = hasAttr(img, "width");
      const hasHeight = hasAttr(img, "height");
      return !hasWidth || !hasHeight;
    });

    if (imgsWithoutDimensions.length > 0) {
      findings.push({
        category: "performance",
        severity: "warning",
        file: file.path,
        message: `${imgsWithoutDimensions.length} image(s) are missing explicit width and height attributes.`,
        suggestion: 'Add width and height attributes to all <img> tags to prevent Cumulative Layout Shift (CLS). The browser can then reserve space before the image loads: <img src="…" width="800" height="400" alt="…">.',
      });
    }

    // 3. Images without loading="lazy"
    const aboveFoldLimit = 3;
    const imgsWithoutLazy = imgTags.slice(aboveFoldLimit).filter(
      (img) => !img.includes('loading="lazy"') && !img.includes("loading='lazy'"),
    );

    if (imgsWithoutLazy.length > 0) {
      findings.push({
        category: "performance",
        severity: "info",
        file: file.path,
        message: `${imgsWithoutLazy.length} below-the-fold image(s) are missing loading="lazy".`,
        suggestion: 'Add loading="lazy" to images that appear below the fold to defer their loading until the user scrolls near them, reducing initial page load time.',
      });
    }

    // 4. Large inline <style> blocks
    const styleBlocks = html.match(/<style(?:\s[^>]*)?>[\s\S]*?<\/style>/gi) ?? [];
    for (const styleBlock of styleBlocks) {
      if (styleBlock.length > 5 * 1024) {
        findings.push({
          category: "performance",
          severity: "warning",
          file: file.path,
          message: `An inline <style> block is ${Math.round(styleBlock.length / 1024)}KB, exceeding the 5KB recommendation.`,
          suggestion: "Extract large inline styles into a separate .css file and load it with <link rel=\"stylesheet\">. This allows browsers to cache the stylesheet and improves parse performance.",
        });
        break; // Report once per file
      }
    }

    // 5. Too many external resource requests
    const externalCount = countExternalResources(html);
    if (externalCount > 10) {
      findings.push({
        category: "performance",
        severity: "warning",
        file: file.path,
        message: `${externalCount} external resource requests detected (scripts, stylesheets, images). Exceeds the recommended 10-request limit.`,
        suggestion: "Reduce external resource requests by combining scripts, using fewer CDN libraries, or loading non-critical resources asynchronously. Each external request adds latency.",
      });
    }
  }

  return findings;
}

// ─── CDN Vulnerability Audit ──────────────────────────────────────────────────

export function auditCdnVulnerabilities(files: BuilderFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const htmls = htmlFiles(files);

  for (const file of htmls) {
    const urls = extractCdnUrls(file.content);
    if (urls.length === 0) continue;

    const cdnFindings = scanCdnUrls(urls);
    for (const finding of cdnFindings) {
      findings.push({
        category: "security",
        severity: finding.severity,
        file: file.path,
        message: `${finding.packageName}${finding.version ? ` v${finding.version}` : ""}: ${finding.description}${finding.cve ? ` (${finding.cve})` : ""}`,
        suggestion: `Update to ${finding.packageName} ${finding.upgradeTo} or later. Replace the CDN URL with a version that is not affected by this vulnerability.`,
      });
    }
  }

  return findings;
}

// ─── Score computation ────────────────────────────────────────────────────────

function computeScore(findings: AuditFinding[], category: AuditCategory): AuditScore {
  const categoryFindings = findings.filter((f) => f.category === category);
  const failures = categoryFindings.filter((f) => f.severity === "error").length;
  const warnings = categoryFindings.filter((f) => f.severity === "warning").length;
  const infos = categoryFindings.filter((f) => f.severity === "info").length;

  const CHECKS_PER_CATEGORY = 6;
  const penalty = failures * 2 + warnings * 1 + infos * 0.25;
  const pass = Math.max(0, CHECKS_PER_CATEGORY - Math.ceil(categoryFindings.length));
  const score = Math.max(0, Math.round(100 - (penalty / CHECKS_PER_CATEGORY) * 100));

  const LABELS: Record<AuditCategory, string> = {
    accessibility: "Accessibility",
    seo: "SEO",
    performance: "Performance",
    security: "Security",
  };

  return {
    category,
    label: LABELS[category],
    pass,
    warnings,
    failures,
    score,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function runAudit(files: BuilderFile[]): AuditReport {
  const accessibilityFindings = auditAccessibility(files);
  const seoFindings = auditSeo(files);
  const performanceFindings = auditPerformance(files);
  const securityFindings = auditCdnVulnerabilities(files);

  const all = [...accessibilityFindings, ...seoFindings, ...performanceFindings, ...securityFindings];

  const scores: AuditScore[] = [
    computeScore(all, "accessibility"),
    computeScore(all, "seo"),
    computeScore(all, "performance"),
    computeScore(all, "security"),
  ];

  return {
    findings: all,
    scores,
    auditedAt: new Date().toISOString(),
    fileCount: htmlFiles(files).length,
  };
}
