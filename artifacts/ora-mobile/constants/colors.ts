/**
 * Semantic design tokens for the Ora mobile app.
 *
 * Dark palette mirrors artifacts/mustaflow/src/index.css `.dark` block (HSL → hex).
 * Light palette mirrors the `.root` (light) block with the same conversion.
 * Both palettes share identical keys so useColors can swap without branching.
 */

const dark = {
  text: "#ffffff",
  tint: "#348af4",

  background: "#080a16",
  foreground: "#ffffff",

  card: "#0c0e1d",
  cardForeground: "#ffffff",
  cardBorder: "#191b2e",

  primary: "#348af4",
  primaryForeground: "#ffffff",

  secondary: "#242642",
  secondaryForeground: "#ffffff",

  muted: "#191b2e",
  mutedForeground: "#a3a6c2",

  accent: "#1c1f40",
  accentForeground: "#3dd6f5",

  destructive: "#ef4343",
  destructiveForeground: "#ffffff",

  border: "#1d1f35",
  input: "#1d1f35",
  ring: "#348af4",

  popover: "#0c0e1d",
  popoverForeground: "#ffffff",

  sidebar: "#06060f",
  sidebarForeground: "#c2c4d6",
  sidebarBorder: "#151728",
  sidebarAccent: "#191b2e",
};

/** Light palette — converted from CSS hsl(235 30% 98%) etc. via the formula below. */
const light = {
  text: "#0d0f26",
  tint: "#0b61cb",

  background: "#f8f9fb",
  foreground: "#0d0f26",

  card: "#ffffff",
  cardForeground: "#0d0f26",
  cardBorder: "#e0e1eb",

  primary: "#0b61cb",
  primaryForeground: "#ffffff",

  secondary: "#d1dff0",
  secondaryForeground: "#06336b",

  muted: "#ededf3",
  mutedForeground: "#52557a",

  accent: "#f3f6f7",
  accentForeground: "#087a91",

  destructive: "#ef4343",
  destructiveForeground: "#ffffff",

  border: "#e0e1eb",
  input: "#e0e1eb",
  ring: "#0b61cb",

  popover: "#ffffff",
  popoverForeground: "#0d0f26",

  sidebar: "#f5f5fa",
  sidebarForeground: "#20223c",
  sidebarBorder: "#d9dae8",
  sidebarAccent: "#e4e6f1",
};

const colors = {
  light,
  dark,
  radius: 12,
};

export default colors;
export type AppColors = typeof dark;
