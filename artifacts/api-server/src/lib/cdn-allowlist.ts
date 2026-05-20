/**
 * CDN Vulnerability Allowlist
 * Maintained registry of CDN packages used in generated apps.
 * Each entry specifies the package name, safe version ranges, and
 * a list of blocked (vulnerable) version patterns with upgrade advice.
 */

export interface CdnPackageEntry {
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** URL patterns that identify this package in CDN links */
  urlPatterns: RegExp[];
  /** Regex patterns to extract the version from the matched URL */
  versionPattern: RegExp;
  /** Known-vulnerable version strings / ranges */
  blockedVersions: Array<{
    match: (version: string) => boolean;
    cve?: string;
    description: string;
    upgradeTo: string;
    /** Override the default "error" severity for this blocked entry (e.g. EOL warnings) */
    severity?: "error" | "warning";
  }>;
  /** Minimum recommended version — older versions trigger a warning even without a specific CVE */
  minimumRecommendedVersion?: string;
}

/** Compare two semver strings; returns negative if a < b */
function semverLt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db;
  }
  return false;
}

export const CDN_ALLOWLIST: CdnPackageEntry[] = [
  {
    name: "tailwindcss",
    displayName: "Tailwind CSS",
    urlPatterns: [
      /cdn\.tailwindcss\.com/,
      /unpkg\.com\/tailwindcss/,
      /cdn\.jsdelivr\.net\/npm\/tailwindcss/,
    ],
    versionPattern: /tailwindcss@([\d.]+)/,
    blockedVersions: [],
    minimumRecommendedVersion: "3.0.0",
  },
  {
    name: "lucide",
    displayName: "Lucide Icons",
    urlPatterns: [/unpkg\.com\/lucide/, /cdn\.jsdelivr\.net\/npm\/lucide/],
    versionPattern: /lucide@([\d.]+)/,
    blockedVersions: [],
    minimumRecommendedVersion: "0.263.0",
  },
  {
    name: "chartjs",
    displayName: "Chart.js",
    urlPatterns: [
      /cdn\.jsdelivr\.net\/npm\/chart\.js/,
      /unpkg\.com\/chart\.js/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js/,
    ],
    versionPattern: /[Cc]hart\.js@?([\d.]+)|[Cc]hart\.js\/([\d.]+)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "3.0.0"),
        cve: "CVE-2019-11358",
        description:
          "Chart.js v2 bundles a vulnerable version of jQuery. Prototype pollution risk.",
        upgradeTo: "4.x",
      },
    ],
    minimumRecommendedVersion: "3.0.0",
  },
  {
    name: "leaflet",
    displayName: "Leaflet.js",
    urlPatterns: [
      /unpkg\.com\/leaflet/,
      /cdn\.jsdelivr\.net\/npm\/leaflet/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet/,
    ],
    versionPattern: /leaflet@([\d.]+)|leaflet\/([\d.]+)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "1.7.0"),
        description:
          "Leaflet versions before 1.7.0 have a known XSS vulnerability in popup content handling.",
        upgradeTo: "1.9.4",
      },
    ],
    minimumRecommendedVersion: "1.7.0",
  },
  {
    name: "alpinejs",
    displayName: "Alpine.js",
    urlPatterns: [
      /unpkg\.com\/alpinejs/,
      /cdn\.jsdelivr\.net\/npm\/alpinejs/,
      /cdn\.skypack\.dev\/alpinejs/,
    ],
    versionPattern: /alpinejs@([\d.]+)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "2.8.2"),
        description:
          "Alpine.js versions before 2.8.2 have an XSS vulnerability via x-html directive.",
        upgradeTo: "3.x",
      },
    ],
    minimumRecommendedVersion: "3.0.0",
  },
  {
    name: "htmx",
    displayName: "htmx",
    urlPatterns: [
      /unpkg\.com\/htmx\.org/,
      /cdn\.jsdelivr\.net\/npm\/htmx\.org/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/htmx/,
    ],
    versionPattern: /htmx\.org@([\d.]+)|htmx\/([\d.]+)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "1.8.0"),
        description: "htmx versions before 1.8.0 may allow unsafe HTML injection via hx-swap.",
        upgradeTo: "2.x",
      },
    ],
    minimumRecommendedVersion: "1.9.0",
  },
  {
    name: "axios",
    displayName: "Axios",
    urlPatterns: [
      /unpkg\.com\/axios/,
      /cdn\.jsdelivr\.net\/npm\/axios/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/axios/,
    ],
    versionPattern: /axios@([\d.]+)|axios\/([\d.]+)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "0.21.2"),
        cve: "CVE-2021-3749",
        description:
          "Axios versions before 0.21.2 are vulnerable to Regular Expression Denial of Service (ReDoS).",
        upgradeTo: "1.x",
      },
      {
        match: (v) => semverLt(v, "1.6.0"),
        cve: "CVE-2023-45857",
        description:
          "Axios versions before 1.6.0 may expose confidential XSRF tokens to a third party.",
        upgradeTo: "1.6.0",
      },
    ],
    minimumRecommendedVersion: "1.6.0",
  },
  {
    name: "lodash",
    displayName: "Lodash",
    urlPatterns: [
      /unpkg\.com\/lodash/,
      /cdn\.jsdelivr\.net\/npm\/lodash/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/lodash\.js/,
    ],
    versionPattern: /lodash@([\d.]+)|lodash\/([\d.]+)|lodash\.js\/([\d.]+)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "4.17.21"),
        cve: "CVE-2021-23337",
        description:
          "Lodash versions before 4.17.21 are vulnerable to prototype pollution via the merge, mergeWith, and defaultsDeep functions.",
        upgradeTo: "4.17.21",
      },
    ],
    minimumRecommendedVersion: "4.17.21",
  },
  {
    name: "animejs",
    displayName: "Anime.js",
    urlPatterns: [
      /unpkg\.com\/animejs/,
      /cdn\.jsdelivr\.net\/npm\/animejs/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/animejs/,
    ],
    versionPattern: /animejs@([\d.]+)|animejs\/([\d.]+)/,
    blockedVersions: [],
    minimumRecommendedVersion: "3.2.0",
  },
  {
    name: "gsap",
    displayName: "GSAP",
    urlPatterns: [
      /unpkg\.com\/gsap/,
      /cdn\.jsdelivr\.net\/npm\/gsap/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/gsap/,
    ],
    versionPattern: /gsap@([\d.]+)|gsap\/([\d.]+)/,
    blockedVersions: [],
    minimumRecommendedVersion: "3.0.0",
  },
  {
    name: "jquery",
    displayName: "jQuery",
    urlPatterns: [
      /code\.jquery\.com\/jquery/,
      /unpkg\.com\/jquery/,
      /cdn\.jsdelivr\.net\/npm\/jquery/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/jquery/,
    ],
    versionPattern: /jquery@([\d.]+)|jquery\/([\d.]+)|jquery-([\d.]+)(?:\.min)?\.js/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "3.5.0"),
        cve: "CVE-2020-11022",
        description:
          "jQuery versions before 3.5.0 are vulnerable to XSS via the HTML-parsing functions. Passing HTML containing <option> elements from untrusted sources can lead to script execution.",
        upgradeTo: "3.7.x",
      },
    ],
    minimumRecommendedVersion: "3.5.0",
  },
  {
    name: "bootstrap",
    displayName: "Bootstrap",
    urlPatterns: [
      /cdn\.jsdelivr\.net\/npm\/bootstrap/,
      /unpkg\.com\/bootstrap/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/bootstrap/,
      /stackpath\.bootstrapcdn\.com/,
      /maxcdn\.bootstrapcdn\.com/,
    ],
    versionPattern:
      /bootstrap@([\d.]+)|bootstrap\/([\d.]+)|bootstrap-([\d.]+)(?:\.min)?\.(?:js|css)/,
    blockedVersions: [
      {
        match: (v) => semverLt(v, "4.3.1"),
        cve: "CVE-2019-8331",
        description:
          "Bootstrap versions before 4.3.1 are vulnerable to XSS via the tooltip and popover data-template attribute.",
        upgradeTo: "5.3.x",
      },
    ],
    minimumRecommendedVersion: "4.3.1",
  },
  {
    name: "vue",
    displayName: "Vue.js",
    urlPatterns: [
      /cdn\.jsdelivr\.net\/npm\/vue/,
      /unpkg\.com\/vue/,
      /cdnjs\.cloudflare\.com\/ajax\/libs\/vue/,
    ],
    versionPattern: /vue@([\d.]+)|vue\/([\d.]+)|vue-([\d.]+)(?:\.min)?\.js/,
    blockedVersions: [
      {
        match: (v) => v.startsWith("2."),
        description:
          "Vue 2.x reached End of Life on December 31, 2023 and no longer receives security patches. Migrate to Vue 3.",
        upgradeTo: "3.x",
        severity: "warning",
      },
    ],
    minimumRecommendedVersion: "3.0.0",
  },
];

/**
 * Scan a list of CDN URLs and return any vulnerability findings.
 */
export interface CdnFinding {
  url: string;
  packageName: string;
  version: string | null;
  cve?: string;
  description: string;
  upgradeTo: string;
  severity: "error" | "warning";
}

export function scanCdnUrls(urls: string[]): CdnFinding[] {
  const findings: CdnFinding[] = [];

  for (const url of urls) {
    for (const entry of CDN_ALLOWLIST) {
      const matchesPattern = entry.urlPatterns.some((p) => p.test(url));
      if (!matchesPattern) continue;

      const versionMatch = url.match(entry.versionPattern);
      const version = versionMatch
        ? (versionMatch[1] ?? versionMatch[2] ?? versionMatch[3] ?? null)
        : null;

      if (version) {
        for (const blocked of entry.blockedVersions) {
          if (blocked.match(version)) {
            findings.push({
              url,
              packageName: entry.displayName,
              version,
              cve: blocked.cve,
              description: blocked.description,
              upgradeTo: blocked.upgradeTo,
              severity: blocked.severity ?? "error",
            });
          }
        }

        if (
          entry.minimumRecommendedVersion &&
          semverLt(version, entry.minimumRecommendedVersion) &&
          !findings.some((f) => f.url === url)
        ) {
          findings.push({
            url,
            packageName: entry.displayName,
            version,
            description: `${entry.displayName} version ${version} is outdated. Consider upgrading to the latest stable release.`,
            upgradeTo: entry.minimumRecommendedVersion,
            severity: "warning",
          });
        }
      }
    }
  }

  return findings;
}
