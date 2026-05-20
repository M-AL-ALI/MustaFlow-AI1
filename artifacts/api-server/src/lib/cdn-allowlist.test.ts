import { describe, it, expect } from "vitest";
import { scanCdnUrls } from "./cdn-allowlist.js";

describe("scanCdnUrls — jQuery (CVE-2020-11022)", () => {
  it("flags jQuery 1.x from code.jquery.com as an error", () => {
    const findings = scanCdnUrls(["https://code.jquery.com/jquery-1.12.4.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cve).toBe("CVE-2020-11022");
    expect(findings[0].packageName).toBe("jQuery");
    expect(findings[0].version).toBe("1.12.4");
  });

  it("flags jQuery 2.x from code.jquery.com as an error", () => {
    const findings = scanCdnUrls(["https://code.jquery.com/jquery-2.2.4.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cve).toBe("CVE-2020-11022");
  });

  it("flags jQuery 3.4.1 (< 3.5.0) from unpkg as an error", () => {
    const findings = scanCdnUrls(["https://unpkg.com/jquery@3.4.1/dist/jquery.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cve).toBe("CVE-2020-11022");
    expect(findings[0].upgradeTo).toBe("3.7.x");
  });

  it("does not flag jQuery 3.5.0 (safe threshold)", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/jquery@3.5.0/dist/jquery.min.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag jQuery 3.7.1 (current recommended)", () => {
    const findings = scanCdnUrls(["https://code.jquery.com/jquery-3.7.1.min.js"]);
    expect(findings).toHaveLength(0);
  });

  it("flags jQuery from cdnjs with version in path", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.3.1/jquery.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].version).toBe("3.3.1");
  });
});

describe("scanCdnUrls — Bootstrap (CVE-2019-8331)", () => {
  it("flags Bootstrap 3.x from jsdelivr as an error", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/bootstrap@3.4.1/dist/js/bootstrap.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cve).toBe("CVE-2019-8331");
    expect(findings[0].packageName).toBe("Bootstrap");
    expect(findings[0].version).toBe("3.4.1");
    expect(findings[0].upgradeTo).toBe("5.3.x");
  });

  it("flags Bootstrap 4.3.0 (< 4.3.1) from unpkg as an error", () => {
    const findings = scanCdnUrls([
      "https://unpkg.com/bootstrap@4.3.0/dist/js/bootstrap.bundle.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].cve).toBe("CVE-2019-8331");
  });

  it("flags Bootstrap 4.2.1 from stackpath CDN as an error", () => {
    const findings = scanCdnUrls([
      "https://stackpath.bootstrapcdn.com/bootstrap/4.2.1/js/bootstrap.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].version).toBe("4.2.1");
  });

  it("does not flag Bootstrap 4.3.1 (safe threshold)", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/bootstrap@4.3.1/dist/js/bootstrap.min.js",
    ]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Bootstrap 5.3.3 (current recommended)", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js",
    ]);
    expect(findings).toHaveLength(0);
  });

  it("flags Bootstrap CSS from cdnjs", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/bootstrap/4.1.3/css/bootstrap.min.css",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].version).toBe("4.1.3");
  });
});

describe("scanCdnUrls — Vue.js (EOL warning)", () => {
  it("flags Vue 2.6.14 from jsdelivr as a warning (EOL)", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/vue@2.6.14/dist/vue.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("Vue.js");
    expect(findings[0].version).toBe("2.6.14");
    expect(findings[0].upgradeTo).toBe("3.x");
  });

  it("flags Vue 2.7.16 (latest 2.x) from unpkg as a warning (EOL)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/vue@2.7.16/dist/vue.global.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("2.7.16");
  });

  it("flags Vue 2.x from cdnjs as a warning (EOL)", () => {
    const findings = scanCdnUrls(["https://cdnjs.cloudflare.com/ajax/libs/vue/2.5.2/vue.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("2.5.2");
  });

  it("does not flag Vue 3.x", () => {
    const findings = scanCdnUrls(["https://unpkg.com/vue@3.4.21/dist/vue.global.prod.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Vue 3.5.x (latest)", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.esm-browser.prod.js",
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe("scanCdnUrls — React (legacy version warning)", () => {
  it("flags React 15.x from unpkg as a warning", () => {
    const findings = scanCdnUrls(["https://unpkg.com/react@15.7.0/umd/react.production.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("React");
    expect(findings[0].version).toBe("15.7.0");
    expect(findings[0].upgradeTo).toBe("18.x");
  });

  it("flags React 16.13.1 (< 16.14.0) from jsdelivr as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/react@16.13.1/umd/react.production.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("16.13.1");
  });

  it("flags React 16.8.0 from cdnjs as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/react/16.8.0/umd/react.production.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("16.8.0");
  });

  it("does not flag React 16.14.0 (safe threshold)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/react@16.14.0/umd/react.production.min.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag React 18.x (current recommended)", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe("scanCdnUrls — D3.js (prototype pollution warning)", () => {
  it("flags D3 v5 from unpkg as a warning", () => {
    const findings = scanCdnUrls(["https://unpkg.com/d3@5.16.0/dist/d3.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("D3.js");
    expect(findings[0].version).toBe("5.16.0");
    expect(findings[0].upgradeTo).toBe("7.x");
  });

  it("flags D3 v6 from jsdelivr as a warning", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/d3@6.7.0/dist/d3.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("6.7.0");
  });

  it("flags D3 v4 from cdnjs as a warning", () => {
    const findings = scanCdnUrls(["https://cdnjs.cloudflare.com/ajax/libs/d3/4.13.0/d3.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("4.13.0");
  });

  it("flags D3 from d3js.org CDN as a warning", () => {
    const findings = scanCdnUrls(["https://d3js.org/d3.v5.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("5");
  });

  it("does not flag D3 v7 (safe threshold)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/d3@7.0.0/dist/d3.min.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag D3 7.9.x (current recommended)", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"]);
    expect(findings).toHaveLength(0);
  });
});

describe("scanCdnUrls — Moment.js (EOL warning)", () => {
  it("flags any Moment.js version from unpkg as a warning", () => {
    const findings = scanCdnUrls(["https://unpkg.com/moment@2.30.1/moment.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("Moment.js");
    expect(findings[0].version).toBe("2.30.1");
    expect(findings[0].upgradeTo).toBe("Luxon or date-fns");
  });

  it("flags Moment.js from jsdelivr as a warning", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/moment@2.29.4/moment.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("2.29.4");
  });

  it("flags Moment.js from cdnjs as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/moment.js/2.29.4/moment.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("2.29.4");
  });

  it("flags the latest Moment.js version (EOL applies to all releases)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/moment@2.30.1/moment.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });
});

describe("scanCdnUrls — Anime.js (versions < 3.2.0)", () => {
  it("flags Anime.js 3.0.0 from unpkg as a warning", () => {
    const findings = scanCdnUrls(["https://unpkg.com/animejs@3.0.0/lib/anime.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("Anime.js");
    expect(findings[0].version).toBe("3.0.0");
    expect(findings[0].upgradeTo).toBe("3.2.0");
  });

  it("flags Anime.js 3.1.0 from jsdelivr as a warning", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/animejs@3.1.0/lib/anime.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("3.1.0");
  });

  it("flags Anime.js 2.2.0 from cdnjs as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/animejs/2.2.0/anime.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("2.2.0");
  });

  it("does not flag Anime.js 3.2.0 (safe threshold)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/animejs@3.2.0/lib/anime.min.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Anime.js 3.2.2 (current recommended)", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js"]);
    expect(findings).toHaveLength(0);
  });
});

describe("scanCdnUrls — Three.js (XSS in TextGeometry, revisions < r140)", () => {
  it("flags Three.js 0.139.2 from unpkg as a warning", () => {
    const findings = scanCdnUrls(["https://unpkg.com/three@0.139.2/build/three.min.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("Three.js");
    expect(findings[0].version).toBe("0.139.2");
    expect(findings[0].upgradeTo).toBe("r170+ (0.170.0)");
  });

  it("flags Three.js 0.100.0 from jsdelivr as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/three@0.100.0/build/three.module.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("0.100.0");
  });

  it("flags Three.js r139 from cdnjs as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/three.js/r139/three.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("139");
    expect(findings[0].upgradeTo).toBe("r170+ (0.170.0)");
  });

  it("flags Three.js r100 from cdnjs as a warning", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/three.js/r100/three.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("100");
  });

  it("does not flag Three.js 0.140.0 (safe threshold, semver)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/three@0.140.0/build/three.min.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Three.js r140 from cdnjs (safe threshold, revision)", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/three.js/r140/three.min.js",
    ]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Three.js 0.170.0 (recommended)", () => {
    const findings = scanCdnUrls([
      "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    ]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Three.js r175 from cdnjs (recommended)", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/three.js/r175/three.min.js",
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe("scanCdnUrls — Svelte (v3.x EOL warning)", () => {
  it("flags Svelte 3.59.2 from unpkg as a warning (EOL)", () => {
    const findings = scanCdnUrls(["https://unpkg.com/svelte@3.59.2/dist/svelte.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].packageName).toBe("Svelte");
    expect(findings[0].version).toBe("3.59.2");
    expect(findings[0].upgradeTo).toBe("5.x");
  });

  it("flags Svelte 3.0.0 from jsdelivr as a warning (EOL)", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/svelte@3.0.0/dist/svelte.js"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("3.0.0");
  });

  it("flags Svelte 3.55.0 from cdnjs as a warning (EOL)", () => {
    const findings = scanCdnUrls([
      "https://cdnjs.cloudflare.com/ajax/libs/svelte/3.55.0/svelte.min.js",
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].version).toBe("3.55.0");
  });

  it("does not flag Svelte 4.x", () => {
    const findings = scanCdnUrls(["https://unpkg.com/svelte@4.2.18/dist/svelte.js"]);
    expect(findings).toHaveLength(0);
  });

  it("does not flag Svelte 5.x (current recommended)", () => {
    const findings = scanCdnUrls(["https://cdn.jsdelivr.net/npm/svelte@5.7.0/dist/svelte.js"]);
    expect(findings).toHaveLength(0);
  });
});

describe("scanCdnUrls — no false positives for unrelated URLs", () => {
  it("returns no findings for a safe Tailwind URL", () => {
    const findings = scanCdnUrls(["https://cdn.tailwindcss.com"]);
    expect(findings).toHaveLength(0);
  });

  it("returns no findings for an empty URL list", () => {
    const findings = scanCdnUrls([]);
    expect(findings).toHaveLength(0);
  });

  it("returns no findings for an unrecognised CDN URL", () => {
    const findings = scanCdnUrls(["https://example.com/some-library.js"]);
    expect(findings).toHaveLength(0);
  });
});
