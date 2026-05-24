---
name: chartjs
description: Render bar, line, pie, and scatter charts with Chart.js — lightweight, canvas-based, easy theming.
triggers: [chart.js, chartjs, bar chart, line chart, pie chart]
---

# Chart.js skill

Use for simple, ready-made charts (bar, line, pie, doughnut, radar, scatter). For free-form custom visualizations, reach for D3 instead.

## Install

```sh
npm install chart.js
```

Vanilla — register what you use (tree-shake-friendly):

```ts
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);
```

React — use `react-chartjs-2`:

```sh
npm install chart.js react-chartjs-2
```

## Do

- Provide `labels` (x-axis values) and one or more `datasets` (each with `data` and styling).
- Use `options.responsive: true` (default) and wrap the canvas in a fixed-aspect-ratio container.
- For multi-series, give each dataset a distinct `borderColor`/`backgroundColor`.
- For time-series, use `type: "line"` with the `time` scale (requires `chartjs-adapter-date-fns` or similar).
- Update data by mutating `chart.data` and calling `chart.update()`.

## Don't

- Don't forget `chart.destroy()` on unmount in React (`react-chartjs-2` does this automatically).
- Don't try to animate hundreds of thousands of points — drop to a static `<canvas>` or switch to a sampling library.

## Examples

### Bar chart (vanilla)

```html
<canvas id="bar"></canvas>
<script type="module">
  import { Chart, registerables } from "chart.js";
  Chart.register(...registerables);
  new Chart(document.getElementById("bar"), {
    type: "bar",
    data: {
      labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      datasets: [{ label: "Sales", data: [12, 19, 3, 5, 2], backgroundColor: "#3b82f6" }],
    },
    options: { responsive: true, plugins: { legend: { position: "top" } } },
  });
</script>
```

### Line chart in React

```tsx
import { Chart, registerables } from "chart.js";
import { Line } from "react-chartjs-2";
Chart.register(...registerables);

export function Sparkline({ values }: { values: number[] }) {
  const data = {
    labels: values.map((_, i) => i + 1),
    datasets: [{ label: "Visits", data: values, borderColor: "#10b981", tension: 0.3 }],
  };
  return <Line data={data} options={{ plugins: { legend: { display: false } } }} />;
}
```

### Doughnut with custom colors

```ts
new Chart(ctx, {
  type: "doughnut",
  data: {
    labels: ["A", "B", "C"],
    datasets: [{ data: [40, 30, 30], backgroundColor: ["#3b82f6", "#10b981", "#f59e0b"] }],
  },
});
```
