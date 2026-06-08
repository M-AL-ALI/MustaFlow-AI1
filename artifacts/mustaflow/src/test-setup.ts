import "@testing-library/jest-dom";

// jsdom lacks the Pointer Capture and scrollIntoView APIs that Radix UI
// overlays (Popover, DropdownMenu, Select, …) call when opening. Without these
// stubs, user-event clicks on a Radix trigger throw and the overlay never
// mounts, so any test that drives a Radix overlay would fail. These are no-op
// shims that make the overlays openable under jsdom.
if (typeof Element !== "undefined") {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
