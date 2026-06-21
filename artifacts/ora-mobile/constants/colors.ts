/**
 * Semantic design tokens for the Ora mobile app.
 *
 * Mirrors the web artifact's dark palette (artifacts/mustaflow/src/index.css
 * `.dark` block) converted from HSL to hex, so both surfaces share a cohesive
 * visual identity. The app is dark-only to match the Ora web experience.
 */

const dark = {
  // Legacy aliases (kept for backward compatibility with scaffold hooks)
  text: "#ffffff",
  tint: "#348af4",

  // Core surfaces
  background: "#080a16",
  foreground: "#ffffff",

  // Cards / elevated surfaces
  card: "#0c0e1d",
  cardForeground: "#ffffff",
  cardBorder: "#191b2e",

  // Primary action color (buttons, links, active states)
  primary: "#348af4",
  primaryForeground: "#ffffff",

  // Secondary / less-emphasis interactive surfaces
  secondary: "#242642",
  secondaryForeground: "#ffffff",

  // Muted / subdued elements (dividers, timestamps, placeholders)
  muted: "#191b2e",
  mutedForeground: "#a3a6c2",

  // Accent highlights (badges, selected items, focus rings, Ora cyan)
  accent: "#1c1f40",
  accentForeground: "#3dd6f5",

  // Destructive actions (delete, error states)
  destructive: "#ef4343",
  destructiveForeground: "#ffffff",

  // Borders and input outlines
  border: "#1d1f35",
  input: "#1d1f35",
  ring: "#348af4",

  // Popover surfaces
  popover: "#0c0e1d",
  popoverForeground: "#ffffff",

  // Sidebar / drawer surfaces
  sidebar: "#06060f",
  sidebarForeground: "#c2c4d6",
  sidebarBorder: "#151728",
  sidebarAccent: "#191b2e",
};

const colors = {
  light: dark,
  dark,
  // Border radius (in px). Synced from the web --radius (0.75rem = 12px).
  radius: 12,
};

export default colors;
export type AppColors = typeof dark;
