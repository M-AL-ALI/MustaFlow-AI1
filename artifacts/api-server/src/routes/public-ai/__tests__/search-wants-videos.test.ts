/**
 * Integration test for the video-intent propagation in runOraWebSearch.
 *
 * Guards the regression where `wantsVideos` was threaded through the route and
 * `runOraWebSearch`'s signature but never actually passed to buildInstructions,
 * so the model never received the video-specific directive. Here we mock the
 * OpenAI client and assert the outbound `instructions` reflect the flag.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => {
  return {
    default: class {
      responses = { create: createMock };
    },
  };
});

import { runOraWebSearch } from "../../../lib/public-ai/web-search";

function mockResponse(text: string) {
  createMock.mockResolvedValueOnce({ output_text: text, output: [] });
}

const SEARCH_ENV_NAMES = [
  "ORA_FREE_SEARCH_MODEL",
  "ORA_CORE_SEARCH_MODEL",
  "ORA_WAVE_SEARCH_MODEL",
  "ORA_SEARCH_MODEL",
] as const;
const ORIGINAL_SEARCH_ENV = new Map(SEARCH_ENV_NAMES.map((name) => [name, process.env[name]]));

describe("runOraWebSearch forwards wantsVideos into instructions", () => {
  beforeEach(() => {
    createMock.mockReset();
    for (const name of SEARCH_ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    for (const name of SEARCH_ENV_NAMES) {
      const original = ORIGINAL_SEARCH_ENV.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  it("includes the video directive when wantsVideos is true", async () => {
    mockResponse('Here are some videos.\n```ora-media\n{"images":[],"videos":[]}\n```');
    await runOraWebSearch({ query: "show me a video about composting", wantsVideos: true });

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { instructions: string };
    expect(arg.instructions).toContain("specifically asking for a video");
    expect(arg.instructions).toContain('"videos" array');
  });

  it("omits the video directive for an ordinary search", async () => {
    mockResponse('The price is X.\n```ora-media\n{"images":[],"videos":[]}\n```');
    await runOraWebSearch({ query: "what is the current bitcoin price" });

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { instructions: string };
    expect(arg.instructions).not.toContain("specifically asking for a video");
  });

  it("uses the plan-aware search model override", async () => {
    process.env.ORA_WAVE_SEARCH_MODEL = "gpt-wave-search";
    mockResponse('Latest info.\n```ora-media\n{"images":[],"videos":[]}\n```');
    await runOraWebSearch({
      query: "latest AI news",
      subscriptionTier: "wave",
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as { model: string };
    expect(arg.model).toBe("gpt-wave-search");
  });
});
