import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { KnowledgeEntry } from "@workspace/api-client-react";
import { OraMemoryManager } from "../ora-memory-manager";

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockAuthFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

const mockRefetch = vi.fn();
const noteEntry: KnowledgeEntry = {
  id: 42,
  title: "my company is Acme Corp",
  content: "my company is Acme Corp",
  type: "note",
} as unknown as KnowledgeEntry;

vi.mock("@workspace/api-client-react", () => ({
  useListKnowledge: () => ({ data: [noteEntry], isLoading: false, refetch: mockRefetch }),
  getListKnowledgeQueryKey: () => ["knowledge"],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/ora-memory-settings", () => ({
  getReferenceSavedMemories: () => true,
  setReferenceSavedMemories: vi.fn(),
  getAutoSaveMemories: () => false,
  setAutoSaveMemories: vi.fn(),
}));

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

  it("shows success toast only when the delete response is ok", async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, status: 200 });
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);
    fireEvent.click(getForgetButton());
    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith("/api/knowledge/42", { method: "DELETE" });
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Memory forgotten" }),
      );
    });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("shows a destructive toast and does NOT report success when delete fails (HTTP 403)", async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 403 });
    render(<OraMemoryManager open={true} onOpenChange={vi.fn()} />);
    fireEvent.click(getForgetButton());
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to forget memory", variant: "destructive" }),
      );
    });
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Memory forgotten" }),
    );
    expect(mockRefetch).not.toHaveBeenCalled();
  });
});
