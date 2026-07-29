import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BUILDER_AGENT_MODES,
  BuilderDeepReasoningIcon,
  BuilderModeIcon,
  normalizeBuilderAgentMode,
} from "./builder-mode-icon";

describe("builder mode icons", () => {
  it("uses a distinct, color-neutral Lucide shape for every mode and Deep Reasoning", () => {
    const { container } = render(
      <div className="text-current">
        {BUILDER_AGENT_MODES.map((mode) => (
          <BuilderModeIcon key={mode} mode={mode} />
        ))}
        <BuilderDeepReasoningIcon />
      </div>,
    );

    for (const icon of ["feather", "leaf", "zap", "gem", "brain"]) {
      expect(container.querySelector(`.lucide-${icon}`)).not.toBeNull();
    }
    expect(container.innerHTML).not.toMatch(/text-(?:red|green|blue|purple|yellow|orange)-/);
  });

  it("normalizes unknown API mode values to Power for presentation", () => {
    expect(normalizeBuilderAgentMode("eco")).toBe("eco");
    expect(normalizeBuilderAgentMode("unknown")).toBe("power");
    expect(normalizeBuilderAgentMode(undefined)).toBe("power");
  });
});
