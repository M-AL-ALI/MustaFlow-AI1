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
