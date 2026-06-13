import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { OraMemoryManager } from "../ora-memory-manager";

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// The manager talks to the isolated Ora memory endpoints (/api/ora/memories),
// NOT the Builder Knowledge Vault (/api/knowledge). authFetch is the single
// transport for fetchOraMemories / deleteOraMemory, so we mock it here.
const mockAuthFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

vi.mock("@/lib/ora-memory-settings", () => ({
  getReferenceSavedMemories: () => true,
  setReferenceSavedMemories: vi.fn(),
  getAutoSaveMemories: () => false,
  setAutoSaveMemories: vi.fn(),
}));

const noteMemory = {
  id: 42,
  title: "my company is Acme Corp",
  content: "my company is Acme Corp",
  category: "personal",
  enabled: true,
  supersededBy: null,
  sourceConversationId: null,
  oraProjectId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** authFetch returns list/usage responses for GETs and configurable acks for mutations. */
function wireAuthFetch(
  options: {
    deleteResponse?: { ok: boolean; status: number };
    patchResponse?: { ok: boolean; status: number };
  } = {},
) {
  mockAuthFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes("/usage")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ count: 1, limit: 200 }),
      });
    }
    if (init?.method === "PATCH") {
      return Promise.resolve({
        ok: options.patchResponse?.ok ?? true,
        status: options.patchResponse?.status ?? 200,
        json: async () => ({ memory: noteMemory }),
      });
    }
    if (init?.method === "DELETE") {
      return Promise.resolve(options.deleteResponse ?? { ok: true, status: 200 });
    }
    // GET /api/ora/memories
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ memories: [noteMemory] }),
    });
  });
}

describe("OraMemoryManager — delete flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function getForgetButton(): HTMLButtonElement {
    const btn = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Forget memory"]',
    );
    if (!btn) throw new Error("Forget memory button not found");
    return btn;
  }

  function getEditButton(): HTMLButtonElement {
    const btn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Edit memory"]');
    if (!btn) throw new Error("Edit memory button not found");
    return btn;
  }

  function getReferenceSwitch(): HTMLElement {
    const sw = document.body.querySelector<HTMLElement>(
      '[role="switch"][aria-labelledby="ora-memory-enabled-42"]',
    );
    if (!sw) throw new Error("Reference memory switch not found");
    return sw;
  }

  it("deletes via the Ora memory endpoint and shows success only when ok", async () => {
    wireAuthFetch({ deleteResponse: { ok: true, status: 200 } });
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);

    // Wait for the memory list to load before interacting with it.
    await waitFor(() => getForgetButton());
    fireEvent.click(getForgetButton());

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining("/api/ora/memories/42"), {
        method: "DELETE",
      });
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Memory forgotten" }),
      );
    });
  });

  it("shows a destructive toast and does NOT report success when delete fails (HTTP 403)", async () => {
    wireAuthFetch({ deleteResponse: { ok: false, status: 403 } });
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => getForgetButton());
    fireEvent.click(getForgetButton());

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to forget memory", variant: "destructive" }),
      );
    });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Memory forgotten" }),
    );
  });

  it("edits a memory through the Ora memory endpoint", async () => {
    wireAuthFetch();
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => getEditButton());
    fireEvent.click(getEditButton());

    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Edit memory"]',
    );
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea!, { target: { value: "my company is MustaFlow" } });

    const save = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Save memory edit"]',
    );
    expect(save).not.toBeNull();
    fireEvent.click(save!);

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining("/api/ora/memories/42"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "my company is MustaFlow",
          content: "my company is MustaFlow",
        }),
      });
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Memory updated" }));
    });
  });

  it("disables a memory without deleting it", async () => {
    wireAuthFetch();
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);

    await waitFor(() => getReferenceSwitch());
    fireEvent.click(getReferenceSwitch());

    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining("/api/ora/memories/42"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Memory disabled" }));
    });
    expect(mockAuthFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/ora/memories/42"),
      { method: "DELETE" },
    );
  });
});
