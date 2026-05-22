export type CheckTrigger = "always" | "agent-selected" | "on-demand";
export type CheckCategory = "security" | "quality" | "accessibility" | "seo" | "performance";

export type CheckDefinition = {
  name: string;
  category: CheckCategory;
  trigger: CheckTrigger;
  description: string;
};

export const CHECK_REGISTRY: CheckDefinition[] = [
  {
    name: "secret-leak",
    category: "security",
    trigger: "always",
    description:
      "Scans all generated HTML/JS files for hardcoded API keys, tokens, passwords, and other secrets. Flags any pattern that looks like a real credential. Always runs — secrets in generated code are a critical security issue.",
  },
  {
    name: "code-quality",
    category: "quality",
    trigger: "always",
    description:
      "Regex-based linter for common code quality issues: eval() usage, document.write, innerHTML with concatenation, console.log left in production code, missing semicolons. Always runs after every build.",
  },
  {
    name: "sast",
    category: "security",
    trigger: "agent-selected",
    description:
      "Security-focused static analysis: XSS sinks (innerHTML with user-controlled data), prototype pollution patterns, sensitive values stored in localStorage/sessionStorage, hardcoded internal endpoint URLs. Run when auth code, forms, or user-input handling was added or changed.",
  },
  {
    name: "accessibility",
    category: "accessibility",
    trigger: "agent-selected",
    description:
      "HTML accessibility audit: missing lang attribute on <html>, images without alt text, form inputs without labels, buttons without accessible text, missing skip-navigation links, low-contrast inline styles. Run when HTML structure, forms, buttons, or navigation was changed.",
  },
  {
    name: "seo",
    category: "seo",
    trigger: "agent-selected",
    description:
      "SEO audit: missing or generic <title>, missing meta description, missing Open Graph tags, missing canonical link, missing structured data. Run when a new page was added or the <head> content changed.",
  },
  {
    name: "performance",
    category: "performance",
    trigger: "agent-selected",
    description:
      "Performance audit: render-blocking scripts in <head> without defer/async, images missing width/height (CLS risk), images missing loading=lazy, large inline style blocks, excessive external resource requests. Run when scripts, images, or stylesheets were added or changed.",
  },
  {
    name: "cdn-security",
    category: "security",
    trigger: "agent-selected",
    description:
      "CDN vulnerability check: compares every CDN URL (script src, link href) against known vulnerable versions for popular libraries (jQuery, Bootstrap, lodash, Moment.js, etc.). Run when a new CDN script or stylesheet was added.",
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
