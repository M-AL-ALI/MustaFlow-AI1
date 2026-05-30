export const PRINT_CSS = `
/* ── Reset ─────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Page setup ─────────────────────────────────────────────────────────── */
@page { size: A4; margin: 18mm 18mm 20mm 18mm; }
@page :first { margin: 0; }

/* ── Base ───────────────────────────────────────────────────────────────── */
body {
  font-family: -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  color: #1a1a1a;
  background: #ffffff;
}

/* ── Cover page ─────────────────────────────────────────────────────────── */
.cover {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100vh;
  padding: 44mm 24mm 30mm;
  page-break-after: always;
  background: #ffffff;
}
.cover-accent {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 11mm;
  background: #1e3a5f;
}
.cover-title {
  font-size: 26pt;
  font-weight: 700;
  color: #1e3a5f;
  line-height: 1.2;
  margin-bottom: 8pt;
  margin-top: 12pt;
}
.cover-type {
  font-size: 13pt;
  color: #4a6285;
  margin-bottom: 26pt;
  font-weight: 400;
}
.cover-rule {
  border: none;
  border-top: 2pt solid #1e3a5f;
  margin: 0 0 22pt;
}
.cover-meta {
  font-size: 10.5pt;
  line-height: 2;
}
.cover-meta-row {
  display: flex;
}
.cover-meta-label {
  min-width: 130pt;
  font-weight: 600;
  color: #1e3a5f;
  flex-shrink: 0;
}
.cover-meta-value {
  color: #333;
}
.cover-footer {
  position: absolute;
  bottom: 14mm;
  left: 24mm;
  right: 24mm;
  text-align: center;
  font-size: 8pt;
  color: #999;
  border-top: 0.5pt solid #ddd;
  padding-top: 5pt;
}

/* ── Content layout ─────────────────────────────────────────────────────── */
.content {
  padding: 0;
}
.report-header {
  margin-bottom: 18pt;
  padding-bottom: 7pt;
  border-bottom: 1.5pt solid #1e3a5f;
}
.report-header h1 {
  font-size: 18pt;
  color: #1e3a5f;
  font-weight: 700;
  border: none;
  padding: 0;
  margin: 0 0 4pt;
}
.report-meta-line {
  font-size: 9pt;
  color: #777;
}

/* ── Headings ───────────────────────────────────────────────────────────── */
h2 {
  font-size: 13pt;
  font-weight: 700;
  color: #1e3a5f;
  margin: 20pt 0 8pt;
  page-break-after: avoid;
}
h3 {
  font-size: 11pt;
  font-weight: 600;
  color: #2c4f7a;
  margin: 12pt 0 5pt;
  page-break-after: avoid;
}

/* ── Body text ──────────────────────────────────────────────────────────── */
p {
  margin: 0 0 6pt;
  line-height: 1.55;
}
.spacer { height: 8pt; }

/* ── Tables ─────────────────────────────────────────────────────────────── */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 6pt 0 14pt;
  font-size: 10pt;
}
thead {
  display: table-header-group;
}
thead th {
  background: #1e3a5f;
  color: #ffffff;
  font-weight: 600;
  padding: 6pt 8pt;
  text-align: left;
  font-size: 9.5pt;
}
tbody td {
  padding: 5pt 8pt;
  border-bottom: 0.5pt solid #d4d9e0;
  vertical-align: top;
  line-height: 1.45;
}
tbody tr:nth-child(even) td {
  background: #f5f7fa;
}
tbody tr {
  page-break-inside: avoid;
}

/* ── KPI status text ────────────────────────────────────────────────────── */
.status-on-target { font-weight: 600; color: #1a5c2a; }
.status-monitor   { font-weight: 600; color: #5a3d00; }
.status-immediate { font-weight: 700; color: #7b1c1c; }

/* ── Trend direction ────────────────────────────────────────────────────── */
.trend-up   { font-weight: 600; }
.trend-down { font-weight: 700; }
.trend-flat { color: #555; }

/* ── Lists ──────────────────────────────────────────────────────────────── */
ul, ol {
  margin: 4pt 0 8pt 18pt;
  padding: 0;
}
li {
  margin-bottom: 3pt;
  line-height: 1.5;
}

/* ── Sections ───────────────────────────────────────────────────────────── */
section {
  margin-bottom: 14pt;
}

/* ── Print enforcement ──────────────────────────────────────────────────── */
@media print {
  body {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  thead th,
  tbody tr:nth-child(even) td,
  .cover-accent {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .status-on-target,
  .status-monitor,
  .status-immediate {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}

/* ── Grayscale fallback ─────────────────────────────────────────────────── */
@media print and (color-index: 0), print and (monochrome) {
  .status-immediate { text-decoration: underline; }
  thead th { background: #333 !important; }
}
`;
