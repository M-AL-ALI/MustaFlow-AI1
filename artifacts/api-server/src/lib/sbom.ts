/**
 * CycloneDX 1.5 SBOM Generator
 *
 * Produces a Software Bill of Materials for a NabuFlow project.
 * Two component groups are included:
 *   1. CDN libraries detected in the generated HTML files.
 *   2. API server npm production dependencies.
 *
 * CVE findings from the CDN scanner are embedded as the `vulnerabilities` array.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CDN_ALLOWLIST, scanCdnUrls } from "./cdn-allowlist";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SbomLicense {
  license: { id: string } | { name: string };
}

interface SbomExternalRef {
  type: "website" | "vcs" | "distribution";
  url: string;
}

interface SbomComponent {
  type: "library";
  "bom-ref": string;
  name: string;
  version: string;
  purl: string;
  licenses: SbomLicense[];
  externalReferences: SbomExternalRef[];
  description?: string;
}

interface SbomVulnerability {
  id: string;
  source?: { name: string; url: string };
  ratings: Array<{ severity: "critical" | "high" | "medium" | "low" | "info" | "none" }>;
  description: string;
  affects: Array<{ ref: string }>;
}

export interface CycloneDxDocument {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: { type: "application"; name: string; version: string };
  };
  components: SbomComponent[];
  vulnerabilities: SbomVulnerability[];
}

// ── Static CDN licence lookup ─────────────────────────────────────────────────

const CDN_LICENSE_MAP: Record<string, string> = {
  tailwindcss: "MIT",
  lucide: "ISC",
  chartjs: "MIT",
  leaflet: "BSD-2-Clause",
  alpinejs: "MIT",
  htmx: "0BSD",
  axios: "MIT",
  lodash: "MIT",
  animejs: "MIT",
  threejs: "MIT",
  svelte: "MIT",
  gsap: "GSAP Standard License",
  jquery: "MIT",
  bootstrap: "MIT",
  react: "MIT",
  d3: "ISC",
  moment: "MIT",
  vue: "MIT",
};

// ── CDN URL extraction ────────────────────────────────────────────────────────

const CDN_HOSTS = [
  "unpkg.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "cdn.tailwindcss.com",
  "cdn.skypack.dev",
  "code.jquery.com",
  "stackpath.bootstrapcdn.com",
  "maxcdn.bootstrapcdn.com",
  "d3js.org",
];

function extractAttr(html: string, attr: string): string[] {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) results.push(m[1]);
  }
  return results;
}

function extractCdnUrls(html: string): string[] {
  const isCdn = (s: string) => CDN_HOSTS.some((h) => s.includes(h));
  const srcs = extractAttr(html, "src").filter(isCdn);
  const hrefs = extractAttr(html, "href").filter(isCdn);
  return [...srcs, ...hrefs];
}

// ── CDN component builder ─────────────────────────────────────────────────────

interface ProjectFile {
  path: string;
  content: string;
  mimeType: string | null;
}

function buildCdnComponents(files: ProjectFile[]): {
  components: SbomComponent[];
  vulnerabilities: SbomVulnerability[];
} {
  const allUrls = new Set<string>();

  for (const file of files) {
    if (file.mimeType === "text/html" || file.path.endsWith(".html")) {
      for (const url of extractCdnUrls(file.content)) {
        allUrls.add(url);
      }
    }
  }

  const components: SbomComponent[] = [];
  const vulnerabilities: SbomVulnerability[] = [];
  const seen = new Set<string>();

  for (const url of allUrls) {
    for (const entry of CDN_ALLOWLIST) {
      if (!entry.urlPatterns.some((p) => p.test(url))) continue;

      const versionMatch = url.match(entry.versionPattern);
      const version = versionMatch
        ? (versionMatch[1] ?? versionMatch[2] ?? versionMatch[3] ?? "unknown")
        : "unknown";

      const key = `${entry.name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const bomRef = `cdn-${entry.name}-${version}`;
      const licenseId = CDN_LICENSE_MAP[entry.name] ?? "Unknown";
      const isSpdx = !licenseId.includes(" ") || licenseId === "0BSD" || licenseId === "ISC";

      components.push({
        type: "library",
        "bom-ref": bomRef,
        name: entry.displayName,
        version,
        purl: `pkg:npm/${entry.name}@${version}`,
        licenses: [isSpdx ? { license: { id: licenseId } } : { license: { name: licenseId } }],
        externalReferences: [{ type: "distribution", url }],
      });

      break;
    }
  }

  const cdnFindings = scanCdnUrls([...allUrls]);
  for (const finding of cdnFindings) {
    if (!finding.cve) continue;

    const affectedEntry = CDN_ALLOWLIST.find((e) => e.urlPatterns.some((p) => p.test(finding.url)));
    const versionMatch = finding.url.match(affectedEntry?.versionPattern ?? /$/);
    const version = versionMatch
      ? (versionMatch[1] ?? versionMatch[2] ?? versionMatch[3] ?? finding.version ?? "unknown")
      : (finding.version ?? "unknown");

    const bomRef = affectedEntry
      ? `cdn-${affectedEntry.name}-${version}`
      : `cdn-unknown-${version}`;

    const severity = finding.severity === "error" ? ("high" as const) : ("medium" as const);

    vulnerabilities.push({
      id: finding.cve,
      source: {
        name: "NVD",
        url: `https://nvd.nist.gov/vuln/detail/${finding.cve}`,
      },
      ratings: [{ severity }],
      description: finding.description,
      affects: [{ ref: bomRef }],
    });
  }

  return { components, vulnerabilities };
}

// ── npm component builder ─────────────────────────────────────────────────────

function readPackageJson(pkgPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveNpmLicense(license: unknown): string {
  if (typeof license === "string") return license;
  if (typeof license === "object" && license !== null) {
    const l = license as Record<string, unknown>;
    if (typeof l["type"] === "string") return l["type"];
    if (typeof l["name"] === "string") return l["name"];
  }
  return "Unknown";
}

function lookupPackageLicense(name: string): string {
  const roots = [
    resolve(process.cwd(), "node_modules", name, "package.json"),
    resolve(process.cwd(), "artifacts/api-server/node_modules", name, "package.json"),
  ];
  for (const p of roots) {
    const pkg = readPackageJson(p);
    if (pkg?.["license"] !== undefined) return resolveNpmLicense(pkg["license"]);
    if (Array.isArray(pkg?.["licenses"])) {
      const lics = pkg["licenses"] as Array<{ type?: string }>;
      return lics.map((l) => l.type ?? "Unknown").join(" AND ");
    }
  }
  return "Unknown";
}

interface NpmListEntry {
  version?: string;
  dependencies?: Record<string, NpmListEntry>;
}

function flattenNpmDeps(
  deps: Record<string, NpmListEntry>,
  result: Map<string, string>,
  depth = 0,
  maxDepth = 2,
): void {
  if (depth > maxDepth) return;
  for (const [name, entry] of Object.entries(deps)) {
    if (!result.has(name) && entry.version) {
      result.set(name, entry.version);
    }
    if (entry.dependencies) {
      flattenNpmDeps(entry.dependencies, result, depth + 1, maxDepth);
    }
  }
}

function buildNpmComponents(): SbomComponent[] {
  const components: SbomComponent[] = [];

  const depMap = new Map<string, string>();

  try {
    const out = execSync("pnpm --filter @workspace/api-server list --json --depth 1 2>/dev/null", {
      encoding: "utf-8",
      timeout: 15_000,
      cwd: process.cwd(),
    });
    const parsed = JSON.parse(out) as Array<{ dependencies?: Record<string, { version: string }> }>;
    if (Array.isArray(parsed) && parsed[0]?.dependencies) {
      for (const [name, entry] of Object.entries(parsed[0].dependencies)) {
        depMap.set(name, entry.version);
      }
    }
  } catch {
    try {
      const raw = execSync("npm list --json --depth 1 2>/dev/null", {
        encoding: "utf-8",
        timeout: 15_000,
        cwd: resolve(process.cwd(), "artifacts/api-server"),
      });
      const parsed = JSON.parse(raw) as { dependencies?: Record<string, NpmListEntry> };
      if (parsed.dependencies) {
        flattenNpmDeps(parsed.dependencies, depMap, 0, 1);
      }
    } catch {
      const pkgJson = readPackageJson(resolve(process.cwd(), "artifacts/api-server/package.json"));
      if (pkgJson?.["dependencies"] && typeof pkgJson["dependencies"] === "object") {
        for (const [name, ver] of Object.entries(
          pkgJson["dependencies"] as Record<string, string>,
        )) {
          if (!name.startsWith("@workspace/")) {
            depMap.set(name, ver.replace(/^[\^~>=]/, ""));
          }
        }
      }
    }
  }

  for (const [name, version] of depMap) {
    if (name.startsWith("@workspace/")) continue;
    const cleanVersion = version.replace(/^[\^~>=]/, "");
    const license = lookupPackageLicense(name);
    // eslint-disable-next-line no-useless-escape
    const isSpdx = /^[A-Za-z0-9.+\-]+$/.test(license) || license === "0BSD";
    const bomRef = `npm-${name.replace(/\//g, "__")}-${cleanVersion}`;

    components.push({
      type: "library",
      "bom-ref": bomRef,
      name,
      version: cleanVersion,
      purl: `pkg:npm/${name}@${cleanVersion}`,
      licenses: [isSpdx ? { license: { id: license } } : { license: { name: license } }],
      externalReferences: [
        {
          type: "distribution",
          url: `https://www.npmjs.com/package/${name}/v/${cleanVersion}`,
        },
      ],
    });
  }

  return components;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generateSbom(projectName: string, files: ProjectFile[]): CycloneDxDocument {
  const { components: cdnComponents, vulnerabilities } = buildCdnComponents(files);
  const npmComponents = buildNpmComponents();

  const allComponents: SbomComponent[] = [...cdnComponents, ...npmComponents];

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "MustaFlow", name: "NabuFlow SBOM Generator", version: "1.0.0" }],
      component: {
        type: "application",
        name: projectName,
        version: "1.0.0",
      },
    },
    components: allComponents,
    vulnerabilities,
  };
}
