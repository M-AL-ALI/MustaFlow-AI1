export type CheckTrigger = "always" | "agent-selected" | "on-demand";
export type CheckCategory =
  | "security"
  | "quality"
  | "accessibility"
  | "seo"
  | "performance"
  | "privacy";

export type CheckDefinition = {
  name: string;
  category: CheckCategory;
  trigger: CheckTrigger;
  description: string;
  fixPrompt: string;
};

export const CHECK_REGISTRY: CheckDefinition[] = [
  {
    name: "syntax",
    category: "quality",
    trigger: "always",
    description:
      "Parses every .js file with Acorn and every .html file with htmlparser2 before files are saved. A syntax error in any file blocks the save and triggers an automatic correction pass. Always runs — invalid syntax would break the preview.",
    fixPrompt:
      "Fix all JavaScript and HTML syntax errors in the generated code. Ensure every .js file is valid ECMAScript 2020 and every .html file has correctly nested, closed tags and well-formed attributes. Do not remove functionality — only correct the broken syntax.",
  },
  {
    name: "secret-leak",
    category: "security",
    trigger: "always",
    description:
      "Scans all generated HTML/JS files for hardcoded API keys, tokens, passwords, and other secrets. Flags any pattern that looks like a real credential. Always runs — secrets in generated code are a critical security issue.",
    fixPrompt:
      "Remove all hardcoded API keys, tokens, and secrets from the generated code. Do NOT delete the surrounding functionality — instead replace each hardcoded value with a placeholder comment like /* TODO: Load from environment */ or a descriptive constant like YOUR_API_KEY_HERE. If the secret is used to call an API, keep the call intact but remove only the literal credential value. Never suggest storing secrets in client-side JavaScript.",
  },
  {
    name: "code-quality",
    category: "quality",
    trigger: "always",
    description:
      "Regex-based linter for common code quality issues: eval() usage, document.write, innerHTML with concatenation, console.log left in production code, missing semicolons. Always runs after every build.",
    fixPrompt:
      "Fix all code quality issues in the generated app: replace eval() calls with safer alternatives, replace document.write() with proper DOM manipulation, fix innerHTML string concatenation with safe DOM methods or template literals with sanitisation, remove console.log statements left in production code, and add missing semicolons.",
  },
  {
    name: "sast",
    category: "security",
    trigger: "agent-selected",
    description:
      "Security-focused static analysis: XSS sinks (innerHTML with user-controlled data), prototype pollution patterns, sensitive values stored in localStorage/sessionStorage, hardcoded internal endpoint URLs. Run when auth code, forms, or user-input handling was added or changed.",
    fixPrompt:
      "Fix all SAST security issues in the generated app: sanitise all innerHTML assignments that use user-controlled data to prevent XSS, remove prototype pollution patterns, move any sensitive values out of localStorage/sessionStorage into more appropriate storage, and replace hardcoded internal endpoint URLs with configurable values.",
  },
  {
    name: "semgrep-sast",
    category: "security",
    trigger: "always",
    description:
      "AST-aware security scanner powered by Semgrep OSS. Uses the p/javascript and p/security-audit rule packs to detect SQL injection, XSS, prototype pollution, insecure patterns, and hundreds of other vulnerability classes that regex-based checks miss. Always runs after every build.",
    fixPrompt:
      "Fix all security vulnerabilities found by Semgrep static analysis. Address each finding at the indicated file and line: sanitize user inputs before using them in DOM operations, avoid eval() and Function() with dynamic strings, prevent prototype pollution by validating object keys, and follow OWASP secure coding guidelines for JavaScript. Do not remove functionality — only fix the insecure patterns.",
  },
  {
    name: "accessibility",
    category: "accessibility",
    trigger: "agent-selected",
    description:
      "HTML accessibility audit: missing lang attribute on <html>, images without alt text, form inputs without labels, buttons without accessible text, missing skip-navigation links, low-contrast inline styles. Run when HTML structure, forms, buttons, or navigation was changed.",
    fixPrompt:
      "Fix all accessibility issues in the generated app: add the lang attribute to the <html> element, add descriptive alt attributes to all images, add associated <label> elements to all form inputs, add accessible text to all buttons (visible text or aria-label), and add a skip-navigation link at the top of the page.",
  },
  {
    name: "seo",
    category: "seo",
    trigger: "agent-selected",
    description:
      "SEO audit: missing or generic <title>, missing meta description, missing Open Graph tags, missing canonical link, missing structured data. Run when a new page was added or the <head> content changed.",
    fixPrompt:
      "Fix all SEO issues in the generated app: add or improve the <title> tag with a descriptive page title, add a meta description tag, add Open Graph tags (og:title, og:description, og:image), add a canonical link tag, and add basic structured data (JSON-LD) for the page type.",
  },
  {
    name: "performance",
    category: "performance",
    trigger: "agent-selected",
    description:
      "Performance audit: render-blocking scripts in <head> without defer/async, images missing width/height (CLS risk), images missing loading=lazy, large inline style blocks, excessive external resource requests. Run when scripts, images, or stylesheets were added or changed.",
    fixPrompt:
      'Fix all performance issues in the generated app: add defer or async attributes to render-blocking <script> tags in the <head>, add explicit width and height attributes to all images to prevent layout shifts, add loading="lazy" to below-the-fold images, and reduce or consolidate external resource requests.',
  },
  {
    name: "cdn-security",
    category: "security",
    trigger: "agent-selected",
    description:
      "CDN vulnerability check: compares every CDN URL (script src, link href) against known vulnerable versions for popular libraries (jQuery, Bootstrap, lodash, Moment.js, etc.). Run when a new CDN script or stylesheet was added.",
    fixPrompt:
      "Update all CDN script and stylesheet URLs to the latest stable versions. Replace any vulnerable or outdated library URLs found in <script src> and <link href> tags with their current secure CDN links from trusted sources like cdnjs.cloudflare.com, jsdelivr.com, or unpkg.com.",
  },
  {
    name: "privacy",
    category: "privacy",
    trigger: "agent-selected",
    description:
      "Privacy and compliance scan: detects known tracker scripts (Google Analytics, Facebook Pixel, Hotjar, Intercom, Mixpanel, Amplitude, Segment, TikTok Pixel) loaded without a consent mechanism, fetch/XHR calls to external third-party endpoints, sensitive fields (email, password, phone, SSN, card) stored in localStorage/sessionStorage, and missing privacy policy links. Run when the app has forms, external scripts, analytics, or user-facing pages.",
    fixPrompt:
      "Fix all privacy and compliance issues in the generated app: add a cookie consent banner that loads tracker scripts only after the user accepts cookies, add a privacy policy link in the app footer, replace any direct storage of sensitive fields (email, password, phone) in localStorage/sessionStorage with safer alternatives, and document all external data flows in the privacy policy.",
  },
];

export function getCheckByName(name: string): CheckDefinition | undefined {
  return CHECK_REGISTRY.find((c) => c.name === name);
}

export function getAlwaysOnChecks(): CheckDefinition[] {
  return CHECK_REGISTRY.filter((c) => c.trigger === "always");
}

export function getAgentSelectedChecks(): CheckDefinition[] {
  return CHECK_REGISTRY.filter((c) => c.trigger === "agent-selected");
}

export function getOnDemandChecks(): CheckDefinition[] {
  return CHECK_REGISTRY.filter((c) => c.trigger === "on-demand");
}
