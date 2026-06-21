import { describe, expect, it } from "vitest";

import { isSafeHttpUrl } from "../safe-url";

// isSafeHttpUrl is the SSRF guard applied to every untrusted web-origin URL
// (sources, images, videos, opened/saved links) before it is rendered or
// fetched. It must mirror the website's `new URL().hostname` based filter,
// including numeric-IPv4 canonicalization of obfuscated localhost/private forms.

describe("isSafeHttpUrl - scheme handling", () => {
  it("accepts ordinary public http(s) URLs", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("http://example.com/path?q=1#frag")).toBe(true);
    expect(isSafeHttpUrl("HTTPS://Example.com")).toBe(true);
  });

  it("rejects non-http schemes and schemeless inputs", () => {
    expect(isSafeHttpUrl("ftp://example.com")).toBe(false);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script></script>")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("//example.com")).toBe(false);
    expect(isSafeHttpUrl("/relative/path")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isSafeHttpUrl("  https://example.com  ")).toBe(true);
  });
});

describe("isSafeHttpUrl - hostnames", () => {
  it("rejects localhost and reserved suffixes", () => {
    expect(isSafeHttpUrl("http://localhost/")).toBe(false);
    expect(isSafeHttpUrl("http://api.localhost/")).toBe(false);
    expect(isSafeHttpUrl("http://service.local/")).toBe(false);
    expect(isSafeHttpUrl("http://db.internal/")).toBe(false);
    expect(isSafeHttpUrl("http://0.0.0.0/")).toBe(false);
  });

  it("rejects dotted-quad private and loopback ranges", () => {
    expect(isSafeHttpUrl("http://127.0.0.1/")).toBe(false);
    expect(isSafeHttpUrl("http://10.1.2.3/")).toBe(false);
    expect(isSafeHttpUrl("http://192.168.0.1/")).toBe(false);
    expect(isSafeHttpUrl("http://172.16.0.1/")).toBe(false);
    expect(isSafeHttpUrl("http://172.31.255.255/")).toBe(false);
    expect(isSafeHttpUrl("http://169.254.1.1/")).toBe(false);
    expect(isSafeHttpUrl("http://0.1.2.3/")).toBe(false);
  });

  it("accepts public IPv4 addresses including range boundaries", () => {
    expect(isSafeHttpUrl("http://8.8.8.8/")).toBe(true);
    expect(isSafeHttpUrl("http://1.1.1.1/")).toBe(true);
    expect(isSafeHttpUrl("http://172.15.0.1/")).toBe(true);
    expect(isSafeHttpUrl("http://172.32.0.1/")).toBe(true);
  });

  it("strips trailing dots before classifying", () => {
    expect(isSafeHttpUrl("http://127.0.0.1./")).toBe(false);
    expect(isSafeHttpUrl("http://localhost./")).toBe(false);
  });
});

describe("isSafeHttpUrl - obfuscated numeric IPv4 (canonicalization)", () => {
  it("rejects decimal, hex, octal and short forms of 127.0.0.1", () => {
    expect(isSafeHttpUrl("http://2130706433/")).toBe(false); // decimal
    expect(isSafeHttpUrl("http://0x7f000001/")).toBe(false); // hex
    expect(isSafeHttpUrl("http://0177.0.0.1/")).toBe(false); // octal first octet
    expect(isSafeHttpUrl("http://127.1/")).toBe(false); // short (a.d)
    expect(isSafeHttpUrl("http://127.0.1/")).toBe(false); // short (a.b.d)
  });

  it("treats malformed/overflowing numeric hosts as unsafe", () => {
    expect(isSafeHttpUrl("http://999.999.999.999/")).toBe(false);
    expect(isSafeHttpUrl("http://4294967296/")).toBe(false); // 2^32, overflow
    expect(isSafeHttpUrl("http://256.0.0.1/")).toBe(false);
  });

  it("still accepts a public address expressed in decimal form", () => {
    // 134744072 === 8.8.8.8 (public) must remain reachable.
    expect(isSafeHttpUrl("http://134744072/")).toBe(true);
  });
});

describe("isSafeHttpUrl - IPv6 and userinfo tricks", () => {
  it("rejects loopback and unique-local/link-local IPv6", () => {
    expect(isSafeHttpUrl("http://[::1]/")).toBe(false);
    expect(isSafeHttpUrl("http://[fc00::1]/")).toBe(false);
    expect(isSafeHttpUrl("http://[fd12:3456::1]/")).toBe(false);
    expect(isSafeHttpUrl("http://[fe80::1]/")).toBe(false);
    expect(isSafeHttpUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
  });

  it("classifies by the real host, ignoring userinfo before '@'", () => {
    expect(isSafeHttpUrl("http://user@127.0.0.1/")).toBe(false);
    expect(isSafeHttpUrl("http://example.com@localhost/")).toBe(false);
    expect(isSafeHttpUrl("https://user:pass@example.com:8443/path")).toBe(true);
  });
});
