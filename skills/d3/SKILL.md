---
name: d3
description: Build custom data visualizations with D3 — scales, axes, selections, and data joins.
triggers: [d3, d3.js, data visualization, custom chart, svg chart]
---

# D3 skill

Use for bespoke visualizations — anything Chart.js doesn't ship out of the box (force-directed graphs, sankey, custom shapes, treemaps, geo maps).

## Install

```sh
npm install d3
npm install -D @types/d3
```

D3 is a collection of modules. Import only what you need: `d3-scale`, `d3-selection`, `d3-shape`, `d3-axis`, `d3-time`, etc. Or `import * as d3 from "d3"`.

## Core ideas

- **Scales** map data values → pixel positions (`scaleLinear`, `scaleBand`, `scaleTime`).
- **Selections** wrap DOM/SVG elements (`d3.select(...)`).
- **Data join** — `.data(arr).join("rect")` creates/updates/removes elements to match the data.

## Do

- Compute scales from your data's `extent` (`d3.extent(data, (d) => d.value)`).
- Render into SVG for crisp lines + DOM inspectability; use canvas only when you have >5–10k marks.
- In React, do the math with D3 (scales, paths) but emit JSX/SVG yourself — don't let D3 manipulate React-managed nodes.
- Use `d3.line()`, `d3.area()`, `d3.arc()` to build path `d` attributes.

## Don't

- Don't mix D3's selection API with React's render cycle on the same nodes — they'll fight.
- Don't recompute scales every render in React — wrap them in `useMemo`.

## Examples

### Bar chart (vanilla)

```ts
import * as d3 from "d3";

const data = [
  { name: "A", v: 30 },
  { name: "B", v: 80 },
  { name: "C", v: 45 },
];
const w = 400,
  h = 200,
  m = { t: 20, r: 20, b: 30, l: 30 };

const svg = d3.select("#chart").append("svg").attr("viewBox", `0 0 ${w} ${h}`);
const x = d3
  .scaleBand()
  .domain(data.map((d) => d.name))
  .range([m.l, w - m.r])
  .padding(0.2);
const y = d3
  .scaleLinear()
  .domain([0, d3.max(data, (d) => d.v)!])
  .nice()
  .range([h - m.b, m.t]);

svg
  .append("g")
  .attr("transform", `translate(0,${h - m.b})`)
  .call(d3.axisBottom(x));
svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y));

svg
  .append("g")
  .selectAll("rect")
  .data(data)
  .join("rect")
  .attr("x", (d) => x(d.name)!)
  .attr("y", (d) => y(d.v))
  .attr("width", x.bandwidth())
  .attr("height", (d) => y(0) - y(d.v))
  .attr("fill", "#3b82f6");
```

### React line chart (D3 for math, React for render)

```tsx
import { useMemo } from "react";
import * as d3 from "d3";

export function LineChart({
  data,
  w = 600,
  h = 200,
}: {
  data: { x: number; y: number }[];
  w?: number;
  h?: number;
}) {
  const { path, xScale, yScale } = useMemo(() => {
    const xs = d3
      .scaleLinear()
      .domain(d3.extent(data, (d) => d.x) as [number, number])
      .range([0, w]);
    const ys = d3
      .scaleLinear()
      .domain(d3.extent(data, (d) => d.y) as [number, number])
      .nice()
      .range([h, 0]);
    const line = d3
      .line<{ x: number; y: number }>()
      .x((d) => xs(d.x))
      .y((d) => ys(d.y));
    return { path: line(data)!, xScale: xs, yScale: ys };
  }, [data, w, h]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`}>
      <path d={path} fill="none" stroke="#3b82f6" strokeWidth={2} />
    </svg>
  );
}
```
