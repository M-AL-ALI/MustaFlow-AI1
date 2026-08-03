// ─────────────────────────────────────────────────────────────────────────────
// OG Image generation — creates an SVG social preview card for a project.
// Served from /api/p/:slug/og-image.svg (no auth, static per publish).
// ─────────────────────────────────────────────────────────────────────────────

/** Escape XML special chars in text content */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap text into lines of at most `maxChars` characters. Returns up to `maxLines`. */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trimStart().length > maxChars) {
      if (current) lines.push(current.trim());
      if (lines.length >= maxLines) break;
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current.trim());
  return lines.slice(0, maxLines);
}

/**
 * Generate an SVG OG card (1200 × 630) for the given project.
 * Uses themeColor if provided; falls back to a blue gradient.
 */
export function generateOgSvg(opts: {
  name: string;
  description?: string | null;
  themeColor?: string | null;
  kind?: string | null;
}): string {
  const { name, description, themeColor, kind } = opts;

  // Pick accent colour
  const accent = themeColor && /^#[0-9a-fA-F]{3,6}$/.test(themeColor) ? themeColor : "#6366f1"; // indigo default

  // Derive a slightly lighter variant for gradient
  const bg1 = "#0a0f1c";
  const bg2 = "#0d1528";

  const titleLines = wrapText(xmlEscape(name || "Untitled App"), 30, 2);
  const descLines = wrapText(xmlEscape(description ?? "Built with NabuFlow"), 58, 3);

  const kindLabel = xmlEscape(
    (kind ?? "web").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  );

  // Build SVG
  const titleY = 220;
  const titleLineHeight = 68;
  const descStartY = titleY + titleLines.length * titleLineHeight + 24;
  const descLineHeight = 38;

  const titleSvg = titleLines
    .map(
      (line, i) =>
        `<text x="80" y="${titleY + i * titleLineHeight}" font-family="system-ui,sans-serif" font-size="60" font-weight="800" fill="#ffffff" letter-spacing="-1">${line}</text>`,
    )
    .join("\n");

  const descSvg = descLines
    .map(
      (line, i) =>
        `<text x="80" y="${descStartY + i * descLineHeight}" font-family="system-ui,sans-serif" font-size="28" fill="#94a3b8">${line}</text>`,
    )
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg1}"/>
      <stop offset="100%" stop-color="${bg2}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${accent}88"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)"/>

  <!-- Accent bar top -->
  <rect x="0" y="0" width="1200" height="6" fill="url(#accent)"/>

  <!-- Grid dots (decorative) -->
  <pattern id="grid" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
    <circle cx="1" cy="1" r="1" fill="#ffffff" opacity="0.04"/>
  </pattern>
  <rect width="1200" height="630" fill="url(#grid)"/>

  <!-- Glow orb -->
  <circle cx="1050" cy="120" r="200" fill="${accent}" opacity="0.06"/>

  <!-- Kind badge -->
  <rect x="80" y="100" width="${kindLabel.length * 12 + 40}" height="36" rx="18" fill="${accent}22" stroke="${accent}44" stroke-width="1"/>
  <text x="100" y="124" font-family="system-ui,sans-serif" font-size="16" font-weight="600" fill="${accent}" letter-spacing="1" text-transform="uppercase">${kindLabel}</text>

  <!-- Title -->
  ${titleSvg}

  <!-- Description -->
  ${descSvg}

  <!-- Footer -->
  <rect x="0" y="580" width="1200" height="50" fill="#ffffff" opacity="0.02"/>
  <text x="80" y="612" font-family="system-ui,sans-serif" font-size="20" fill="#475569" font-weight="500">NabuFlow</text>
  <text x="1120" y="612" font-family="system-ui,sans-serif" font-size="20" fill="${accent}" font-weight="600" text-anchor="end">www.mustaflow.com</text>
</svg>`;
}
