/**
 * Phase 7B-2 PPTX validation script.
 * Step 1 (Node.js): Build a realistic 10-slide PPTX with mock dataset and write to /tmp/test-7b2.pptx.
 * Step 2 (Python):  Inspect the file via Python's built-in zipfile module and validate structure/content.
 */

import { createRequire } from "module";
import { statSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const PptxGenJS = require("/home/runner/workspace/node_modules/.pnpm/pptxgenjs@4.0.1/node_modules/pptxgenjs/dist/pptxgen.cjs.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Mock dataset — all 10 slide sections fully populated ─────────────────────
const MOCK = {
  analysisType: "operations-review",
  summary:
    "The operations dataset reveals significant throughput pressure in Q2 driven by three compounding factors: supplier delivery delays (avg +4.2 days), unplanned downtime on Line 4 (+18% vs plan), and a 12% spike in defect rate in the final assembly stage. Overall OEE stands at 68%, below the 80% target. Immediate action is required on Line 4 and supplier SLA enforcement.",
  keyFindings: [
    "Line 4 unplanned downtime is 18% above plan — primary revenue risk",
    "Defect rate at final assembly rose to 4.1% (target: <2%)",
    "Supplier on-time delivery dropped to 76% (SLA requires 92%)",
    "Throughput in Weeks 14-18 averaged 94 units/day vs 110 target",
    "Rework hours increased 31% quarter-over-quarter",
  ],
  kpiGaps: [
    { metric: "OEE", current: "68%", target: "80%", gap: "-12pp", trend: "down" },
    { metric: "Defect Rate", current: "4.1%", target: "<2%", gap: "+2.1pp", trend: "up" },
    { metric: "On-Time Delivery", current: "76%", target: "92%", gap: "-16pp", trend: "down" },
    { metric: "Throughput (units/day)", current: "94", target: "110", gap: "-16", trend: "stable" },
    { metric: "Rework Hours/Week", current: "312", target: "200", gap: "+112h", trend: "up" },
  ],
  rootCauseAnalysis: {
    likelyCauses: [
      "Worn bearing assembly on Line 4 machine M-07 (vibration sensor data)",
      "Supplier ABC-3 consistently ships undersized batch sizes since Week 12",
    ],
    fiveWhys: [
      "Why is OEE low? Unplanned downtime on Line 4",
      "Why is Line 4 down? M-07 bearing failure",
      "Why did M-07 fail? Missed preventive maintenance cycle in Week 10",
    ],
  },
  risksAndLimitations: [
    "If Line 4 is not repaired by Week 22, Q3 output target will be missed by ~15%",
    "Current supplier dependency on ABC-3 (48% of component supply) creates fragility",
    "Defect trend at 4.1% may trigger customer SLA penalties (breach threshold: 4.5%)",
    "Analysis covers 18 weeks — seasonal effects not yet isolated",
  ],
  recommendations: [
    "Schedule emergency bearing replacement on M-07 by EOW 21",
    "Issue formal SLA warning to ABC-3 and activate secondary supplier",
    "Implement 100% inspection gate at final assembly until defect rate drops below 2%",
    "Restore and enforce PM schedule — assign dedicated maintenance tech to Line 4",
    "Launch root cause team for rework spike (cross-functional, Week 21 kickoff)",
    "Review Q3 throughput target given current OEE trajectory",
  ],
  actionPlan: [
    {
      action: "Replace M-07 bearing",
      priority: "high",
      owner: "Maintenance Lead",
      timeline: "Week 21",
    },
    {
      action: "Issue ABC-3 SLA warning letter",
      priority: "high",
      owner: "Procurement",
      timeline: "Week 21",
    },
    {
      action: "Activate secondary supplier for 25% volume",
      priority: "high",
      owner: "Procurement",
      timeline: "Week 22",
    },
    {
      action: "Implement final assembly 100% inspection gate",
      priority: "high",
      owner: "Quality Manager",
      timeline: "Week 21",
    },
    {
      action: "Restore PM schedule for all Lines",
      priority: "medium",
      owner: "Maintenance Lead",
      timeline: "Week 22",
    },
    {
      action: "Root cause kickoff meeting for rework",
      priority: "medium",
      owner: "Ops Director",
      timeline: "Week 21",
    },
  ],
  nextSteps: [
    "Daily Line 4 status check-in until M-07 is operational",
    "Procurement review with ABC-3 executive team by Friday",
    "Weekly defect rate dashboard — report to leadership every Monday",
    "Q3 throughput reforecast by Week 22",
  ],
};

// ── Colour palette (mirrors generate-pptx.ts) ────────────────────────────────
const C = {
  titleBg: "0F172A",
  accent: "2563EB",
  heading: "1E3A5F",
  body: "1E293B",
  muted: "64748B",
  footer: "94A3B8",
  white: "FFFFFF",
  lightBlue: "7DD3FC",
  tablHdr: "1E3A5F",
  tablHdrFg: "FFFFFF",
  tablRow0: "F8FAFC",
  tablRow1: "FFFFFF",
  border: "E2E8F0",
};

const MAX_BULLETS = 10;
const MAX_TABLE_ROWS = 12;
const MAX_SLIDES = 20;
const DATE = new Date().toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

// ── Presentation assembly ─────────────────────────────────────────────────────
const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
let slideCount = 0;

const nextSlide = () => {
  if (slideCount >= MAX_SLIDES) return null;
  slideCount++;
  return pptx.addSlide();
};

const addFooter = (s) =>
  s.addText("Confidential \u00B7 Generated by Ora AI \u00B7 MustaFlow", {
    x: 0.3,
    y: 7.15,
    w: 12.73,
    h: 0.35,
    fontSize: 9,
    color: C.footer,
    align: "right",
  });

const addHeading = (s, text) => {
  s.addText(text, {
    x: 0.5,
    y: 0.25,
    w: 12.33,
    h: 0.8,
    fontSize: 26,
    bold: true,
    color: C.heading,
  });
  s.addText(" ", {
    x: 0.5,
    y: 1.1,
    w: 12.33,
    h: 0.06,
    fill: { color: C.accent },
    fontSize: 1,
    color: C.accent,
  });
};

const addSection = (title, bullets, numbered = false) => {
  const s = nextSlide();
  if (!s) return;
  addHeading(s, title);
  const items = bullets.slice(0, MAX_BULLETS);
  const textItems = items.map((b, i) => ({
    text: `${numbered ? `${i + 1}.  ` : "\u2022  "}${b}`,
    options: { breakLine: true, paraSpaceBefore: i === 0 ? 0 : 10 },
  }));
  s.addText(textItems, {
    x: 0.5,
    y: 1.25,
    w: 12.33,
    h: 5.65,
    fontSize: 15,
    color: C.body,
    valign: "top",
  });
  addFooter(s);
};

const addTableSection = (title, headers, rows, colW) => {
  const s = nextSlide();
  if (!s) return;
  addHeading(s, title);
  const capped = rows.slice(0, MAX_TABLE_ROWS);
  const mkRow = (cells, isHdr, ri) =>
    cells.map((text) => ({
      text,
      options: {
        bold: isHdr,
        fontSize: isHdr ? 13 : 12,
        color: isHdr ? C.tablHdrFg : C.body,
        fill: { color: isHdr ? C.tablHdr : ri % 2 === 0 ? C.tablRow0 : C.tablRow1 },
        margin: [4, 6, 4, 6],
        valign: "middle",
      },
    }));
  s.addTable([mkRow(headers, true, 0), ...capped.map((r, i) => mkRow(r, false, i))], {
    x: 0.5,
    y: 1.25,
    w: 12.33,
    rowH: 0.38,
    ...(colW ? { colW } : {}),
    border: { type: "solid", pt: 0.5, color: C.border },
  });
  addFooter(s);
};

// Slide 1 — Title (dark background)
{
  const s = nextSlide();
  s.background = { color: C.titleBg };
  s.addText("Operations Review Report", {
    x: 0.8,
    y: 2.1,
    w: 11.73,
    h: 1.6,
    fontSize: 40,
    bold: true,
    color: C.white,
    align: "center",
  });
  s.addText("Operations Review", {
    x: 0.8,
    y: 3.8,
    w: 11.73,
    h: 0.65,
    fontSize: 18,
    color: C.lightBlue,
    align: "center",
  });
  s.addText(`Generated by Ora AI \u00B7 MustaFlow \u00B7 ${DATE}`, {
    x: 0.8,
    y: 4.6,
    w: 11.73,
    h: 0.5,
    fontSize: 12,
    color: C.muted,
    align: "center",
  });
}

// Slide 2 — Executive Summary
{
  const s = nextSlide();
  addHeading(s, "Executive Summary");
  s.addText(MOCK.summary, {
    x: 0.5,
    y: 1.25,
    w: 12.33,
    h: 2.85,
    fontSize: 14,
    color: C.body,
    valign: "top",
    wrap: true,
  });
  s.addText("Key Highlights", {
    x: 0.5,
    y: 4.15,
    w: 12.33,
    h: 0.45,
    fontSize: 14,
    bold: true,
    color: C.heading,
  });
  s.addText(
    MOCK.keyFindings.slice(0, 3).map((h, i) => ({
      text: `\u2022  ${h}`,
      options: { breakLine: true, paraSpaceBefore: i === 0 ? 0 : 8 },
    })),
    { x: 0.5, y: 4.65, w: 12.33, h: 2.2, fontSize: 14, color: C.body, valign: "top" },
  );
  addFooter(s);
}

// Slide 3 — Key Findings
addSection("Key Findings", MOCK.keyFindings, true);

// Slide 4 — KPI Performance
addTableSection(
  "KPI Performance",
  ["Metric", "Current", "Target", "Gap", "Trend"],
  MOCK.kpiGaps.map((k) => [k.metric, k.current, k.target, k.gap, k.trend]),
  [3.5, 2.0, 2.0, 2.33, 2.5],
);

// Slide 5 — Root Cause Analysis
addSection("Root Cause Analysis", [
  ...MOCK.rootCauseAnalysis.likelyCauses.map((c) => `Root Cause: ${c}`),
  ...MOCK.rootCauseAnalysis.fiveWhys.slice(0, 3).map((w, i) => `Why ${i + 1}: ${w}`),
]);

// Slide 6 — Risks and Limitations
addSection("Risks and Limitations", MOCK.risksAndLimitations);

// Slide 7 — Key Opportunities (top half of recommendations)
addSection(
  "Key Opportunities",
  MOCK.recommendations.slice(0, Math.ceil(MOCK.recommendations.length / 2)),
  true,
);

// Slide 8 — Recommendations (full list)
addSection("Recommendations", MOCK.recommendations, true);

// Slide 9 — Action Plan
addTableSection(
  "Action Plan",
  ["Action", "Priority", "Owner", "Timeline"],
  MOCK.actionPlan.map((a) => [a.action, a.priority, a.owner, a.timeline]),
  [5.83, 2.0, 2.0, 2.5],
);

// Slide 10 — Next Steps
addSection("Next Steps", MOCK.nextSteps);

// ── Write to disk ─────────────────────────────────────────────────────────────
const OUT = "/tmp/test-7b2.pptx";
await pptx.writeFile({ fileName: OUT });

const sizeKb = (statSync(OUT).size / 1024).toFixed(1);
console.log(`\nGenerated: ${OUT}  (${sizeKb} KB, ${slideCount} slides)`);

// ── Inspect via Python zipfile ────────────────────────────────────────────────
const inspectScript = path.join(__dirname, "validate-pptx-7b2-inspect.py");
const result = spawnSync("python3", [inspectScript], { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
