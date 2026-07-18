import type { TabularData } from "./file-builder.js";

export type FileChartType = "bar" | "line" | "histogram" | "scatter" | "pareto";

export interface FileChartSpec {
  title: string;
  chartType: FileChartType;
  labels: string[];
  values: number[];
  xLabel?: string;
  yLabel?: string;
  valueSuffix?: string;
}

const CHART_TYPES = new Set<FileChartType>(["bar", "line", "histogram", "scatter", "pareto"]);
const MAX_CHARTS = 4;
const MAX_POINTS = 12;

function cleanLabel(value: unknown, fallback = "Item"): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = Number.parseFloat(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item, i) => cleanLabel(item, `Item ${i + 1}`)) : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(toNumber).filter((item): item is number => item !== null)
    : [];
}

export function normalizeFileChartSpec(value: unknown): FileChartSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const title = cleanLabel(raw.title ?? raw.name ?? "Generated Chart", "Generated Chart");
  const chartTypeRaw = String(raw.chartType ?? raw.type ?? "bar").toLowerCase();
  const chartType = CHART_TYPES.has(chartTypeRaw as FileChartType)
    ? (chartTypeRaw as FileChartType)
    : "bar";
  const labels = asStringArray(raw.labels ?? raw.categories ?? raw.x);
  const values = asNumberArray(raw.values ?? raw.data ?? raw.y);
  const pairs = labels
    .map((label, i) => ({ label, value: values[i] }))
    .filter((row): row is { label: string; value: number } => Number.isFinite(row.value));
  if (pairs.length < 2) return null;
  return {
    title,
    chartType,
    labels: pairs.slice(0, MAX_POINTS).map((row) => row.label),
    values: pairs.slice(0, MAX_POINTS).map((row) => row.value),
    xLabel: cleanLabel(raw.xLabel ?? raw.xColumn ?? "", "") || undefined,
    yLabel: cleanLabel(raw.yLabel ?? raw.yColumn ?? "", "") || undefined,
    valueSuffix: cleanLabel(raw.valueSuffix ?? "", "") || undefined,
  };
}

export function normalizeFileChartSpecs(value: unknown): FileChartSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: FileChartSpec[] = [];
  for (const item of value) {
    const spec = normalizeFileChartSpec(item);
    if (spec) specs.push(spec);
    if (specs.length >= MAX_CHARTS) break;
  }
  return specs;
}

function numericColumnIndexes(data: TabularData): number[] {
  return data.headers
    .map((_, index) => index)
    .filter((index) => {
      const type = data.columnTypes?.[index];
      if (type === "number" || type === "currency" || type === "percent") return true;
      const values = data.rows
        .map((row) => toNumber(row[index]))
        .filter((value): value is number => value !== null);
      return values.length >= Math.max(2, Math.ceil(data.rows.length * 0.6));
    });
}

function categoryColumnIndexes(data: TabularData): number[] {
  return data.headers
    .map((_, index) => index)
    .filter((index) => {
      const type = data.columnTypes?.[index];
      if (type === "number" || type === "currency" || type === "percent") return false;
      const unique = new Set(data.rows.map((row) => cleanLabel(row[index], ""))).size;
      return unique >= 2 && unique <= 30;
    });
}

function aggregateCategory(
  data: TabularData,
  categoryIndex: number,
  numericIndex: number,
): FileChartSpec | null {
  const totals = new Map<string, number>();
  for (const row of data.rows) {
    const label = cleanLabel(row[categoryIndex], "Other");
    const value = toNumber(row[numericIndex]) ?? 0;
    totals.set(label, (totals.get(label) ?? 0) + value);
  }
  const rows = [...totals.entries()]
    .map(([label, value]) => ({ label, value }))
    .filter((row) => row.value !== 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, MAX_POINTS);
  if (rows.length < 2) return null;
  const metric = data.headers[numericIndex] ?? "Value";
  const category = data.headers[categoryIndex] ?? "Category";
  return {
    title: `${metric} by ${category}`,
    chartType: "bar",
    labels: rows.map((row) => row.label),
    values: rows.map((row) => row.value),
    xLabel: category,
    yLabel: metric,
  };
}

function histogram(data: TabularData, numericIndex: number): FileChartSpec | null {
  const values = data.rows
    .map((row) => toNumber(row[numericIndex]))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length < 3) return null;
  const min = values[0]!;
  const max = values[values.length - 1]!;
  if (min === max) return null;
  const binCount = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    min: min + i * width,
    max: i === binCount - 1 ? max : min + (i + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const idx = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[idx]!.count++;
  }
  const metric = data.headers[numericIndex] ?? "Value";
  return {
    title: `${metric} distribution`,
    chartType: "histogram",
    labels: bins.map((bin) => `${formatShort(bin.min)}-${formatShort(bin.max)}`),
    values: bins.map((bin) => bin.count),
    xLabel: metric,
    yLabel: "Count",
  };
}

function formatShort(value: number): string {
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("en-US");
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(/\.0$/, "");
}

export function inferChartsFromTabularData(
  data: TabularData,
  request = "",
  maxCharts = MAX_CHARTS,
): FileChartSpec[] {
  const numeric = numericColumnIndexes(data);
  if (numeric.length === 0 || data.rows.length < 2) return [];
  const category = categoryColumnIndexes(data);
  const wantsHistogram = /\b(histogram|distribution|spread|outliers?|frequency)\b/i.test(request);
  const charts: FileChartSpec[] = [];

  if (wantsHistogram) {
    const hist = histogram(data, numeric[0]!);
    if (hist) charts.push(hist);
  }

  if (category.length > 0) {
    const bar = aggregateCategory(data, category[0]!, numeric[0]!);
    if (bar) charts.push(bar);
  }

  if (!wantsHistogram) {
    const hist = histogram(data, numeric[0]!);
    if (hist) charts.push(hist);
  }

  return charts.slice(0, maxCharts);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildChartSvg(chart: FileChartSpec, width = 900, height = 420): string {
  const margin = { left: 70, right: 34, top: 58, bottom: 78 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const values = chart.values.slice(0, MAX_POINTS);
  const labels = chart.labels.slice(0, values.length);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max === min ? 1 : max - min;
  const y = (value: number) => margin.top + ((max - value) / span) * plotH;
  const zeroY = y(0);
  const color = "#2563eb";
  const muted = "#64748b";
  const grid = "#e2e8f0";

  const bars = values
    .map((value, i) => {
      const slot = plotW / values.length;
      const barW = Math.max(14, slot * 0.58);
      const x = margin.left + i * slot + (slot - barW) / 2;
      const yy = Math.min(y(value), zeroY);
      const h = Math.max(2, Math.abs(zeroY - y(value)));
      return `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}"/>`;
    })
    .join("");

  const points = values
    .map((value, i) => {
      const x = margin.left + (i + 0.5) * (plotW / values.length);
      return `${x.toFixed(1)},${y(value).toFixed(1)}`;
    })
    .join(" ");
  const line =
    chart.chartType === "line" || chart.chartType === "scatter"
      ? `<polyline fill="none" stroke="${color}" stroke-width="4" points="${points}"/>` +
        values
          .map((value, i) => {
            const x = margin.left + (i + 0.5) * (plotW / values.length);
            return `<circle cx="${x.toFixed(1)}" cy="${y(value).toFixed(1)}" r="5" fill="${color}"/>`;
          })
          .join("")
      : bars;

  const labelEls = labels
    .map((label, i) => {
      const x = margin.left + (i + 0.5) * (plotW / labels.length);
      return `<text x="${x.toFixed(1)}" y="${height - 34}" text-anchor="middle" font-size="12" fill="${muted}" transform="rotate(-25 ${x.toFixed(1)} ${height - 34})">${xmlEscape(label)}</text>`;
    })
    .join("");

  const valueEls = values
    .map((value, i) => {
      const x = margin.left + (i + 0.5) * (plotW / values.length);
      return `<text x="${x.toFixed(1)}" y="${Math.max(24, y(value) - 8).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#0f172a">${xmlEscape(formatShort(value) + (chart.valueSuffix ?? ""))}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${margin.left}" y="30" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#0f172a">${xmlEscape(chart.title)}</text>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1"/>
  <line x1="${margin.left}" y1="${zeroY.toFixed(1)}" x2="${margin.left + plotW}" y2="${zeroY.toFixed(1)}" stroke="#94a3b8" stroke-width="1"/>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left + plotW}" y2="${margin.top}" stroke="${grid}" stroke-width="1"/>
  <line x1="${margin.left}" y1="${margin.top + plotH / 2}" x2="${margin.left + plotW}" y2="${margin.top + plotH / 2}" stroke="${grid}" stroke-width="1"/>
  ${line}
  ${valueEls}
  ${labelEls}
  ${chart.xLabel ? `<text x="${margin.left + plotW / 2}" y="${height - 8}" text-anchor="middle" font-size="12" fill="${muted}">${xmlEscape(chart.xLabel)}</text>` : ""}
  ${chart.yLabel ? `<text x="18" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" fill="${muted}" transform="rotate(-90 18 ${margin.top + plotH / 2})">${xmlEscape(chart.yLabel)}</text>` : ""}
</svg>`;
}

export async function renderChartPng(
  chart: FileChartSpec,
  width = 900,
  height = 420,
): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(buildChartSvg(chart, width, height)))
    .png()
    .toBuffer();
}
