// Single source of truth for whether the AI Builder experience is live.
// While false, the AI Build Mode is shown as "Coming soon" on the mode-select
// screen, builder-only routes redirect to mode-select, and returning users whose
// saved preference is the builder land on mode-select instead of /projects.
// Flip this to true (in one place) once the build experience is ready.
export const BUILDER_ENABLED = false;
