import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { OraMessageActions } from "../ora-message-actions";
import type { OraMessage } from "@/hooks/use-ora-chat";
import type { DatasetAnalysisResult } from "@/types/dataset-analysis";

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockCopyMessageText = vi.fn().mockResolvedValue("ok");
const mockDownloadMessageAsMarkdown = vi.fn();
const mockDownloadDatasetReport = vi.fn();
const mockDownloadDatasetJson = vi.fn();
const mockDownloadActionPlanCsv = vi.fn();

vi.mock("@/lib/ora-message-export", () => ({
  copyMessageText: (...args: unknown[]) => mockCopyMessageText(...args),
  downloadMessageAsMarkdown: (...args: unknown[]) => mockDownloadMessageAsMarkdown(...args),
  downloadDatasetReport: (...args: unknown[]) => mockDownloadDatasetReport(...args),
  downloadDatasetJson: (...args: unknown[]) => mockDownloadDatasetJson(...args),
  downloadActionPlanCsv: (...args: unknown[]) => mockDownloadActionPlanCsv(...args),
  sanitizeFilename: (s: string) => s,
  formatOraMessageForMarkdown: (m: { content: string }) => m.content,
}));

const userMessage: OraMessage = {
  role: "user",
  content: "Tell me about React hooks",
};

const assistantMessage: OraMessage = {
  role: "assistant",
  content: "React hooks let you use state and other React features in function components.",
};

const imageAnalysisMessage: OraMessage = {
  role: "assistant",
  content: "The image shows a bar chart with quarterly revenue data.",
  messageKind: "image-analysis",
};

const documentAnalysisMessage: OraMessage = {
  role: "assistant",
  content: "The document outlines the company's 5-year growth strategy.",
  messageKind: "document-analysis",
};

const datasetResult: DatasetAnalysisResult = {
  type: "dataset-analysis",
  analysisType: "kpi",
  summary: "Revenue is up 20% year-over-year.",
  keyFindings: ["Growth is accelerating", "Q4 is strongest"],
  actionPlan: [
    { action: "Increase marketing spend", priority: "high", owner: "CMO", timeline: "Q1" },
    { action: "Hire 5 engineers", priority: "medium", timeline: "Q2" },
  ],
  usedFallback: false,
  sanitizedCellCount: 0,
  truncated: false,
};

const datasetMessage: OraMessage = {
  role: "assistant",
  content: "Revenue is up 20% year-over-year.",
  datasetResult,
};

function renderActions(
  props: Partial<React.ComponentProps<typeof OraMessageActions>> & { message: OraMessage },
) {
  const { container } = render(
    <OraMessageActions
      isLatestAssistant={false}
      onEdit={vi.fn()}
      onRegenerate={undefined}
      onReadAloud={undefined}
      isTtsAvailable={false}
      hasAttachment={false}
      {...props}
    />,
  );
  return { container };
}

function getAllButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
}

function getButtonByLabel(
  container: HTMLElement,
  label: string | RegExp,
): HTMLButtonElement | null {
  const buttons = getAllButtons(container);
  return (
    buttons.find((btn) => {
      const ariaLabel = btn.getAttribute("aria-label") ?? "";
      if (typeof label === "string") return ariaLabel === label;
      return label.test(ariaLabel);
    }) ?? null
  );
}

function getAllButtonLabels(container: HTMLElement): string[] {
  return getAllButtons(container).map((btn) => btn.getAttribute("aria-label") ?? "");
}

describe("OraMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCopyMessageText.mockResolvedValue("ok");
  });

  afterEach(() => {
    cleanup();
  });

  describe("User messages", () => {
    it("renders Copy button for user message", () => {
      const { container } = renderActions({ message: userMessage });
      expect(getButtonByLabel(container, "Copy")).not.toBeNull();
    });

    it("renders Edit button when onEdit is provided for user message", () => {
      const { container } = renderActions({ message: userMessage, onEdit: vi.fn() });
      expect(getButtonByLabel(container, "Edit")).not.toBeNull();
    });

    it("does not render Download button for user messages", () => {
      const { container } = renderActions({ message: userMessage });
      const labels = getAllButtonLabels(container);
      expect(labels.some((l) => /download/i.test(l))).toBe(false);
    });

    it("calls clipboard API on Copy click", async () => {
      const { container } = renderActions({ message: userMessage });
      const btn = getButtonByLabel(container, "Copy");
      expect(btn).not.toBeNull();
      fireEvent.click(btn!);
      await waitFor(() => {
        expect(mockCopyMessageText).toHaveBeenCalledWith(userMessage);
      });
    });

    it("calls onEdit with message content on Edit click", () => {
      const onEdit = vi.fn();
      const { container } = renderActions({ message: userMessage, onEdit });
      const btn = getButtonByLabel(container, "Edit");
      expect(btn).not.toBeNull();
      fireEvent.click(btn!);
      expect(onEdit).toHaveBeenCalledWith(userMessage.content);
    });

    it("shows toast on successful copy", async () => {
      const { container } = renderActions({ message: userMessage });
      fireEvent.click(getButtonByLabel(container, "Copy")!);
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Copied" }));
      });
    });

    it("shows error toast when copy fails", async () => {
      mockCopyMessageText.mockResolvedValue("failed");
      const { container } = renderActions({ message: userMessage });
      fireEvent.click(getButtonByLabel(container, "Copy")!);
      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Copy failed" }));
      });
    });
  });

  describe("Assistant messages", () => {
    it("renders Copy button for assistant message", () => {
      const { container } = renderActions({ message: assistantMessage });
      expect(getButtonByLabel(container, "Copy")).not.toBeNull();
    });

    it("renders Download button for assistant message", () => {
      const { container } = renderActions({ message: assistantMessage });
      const labels = getAllButtonLabels(container);
      expect(labels.some((l) => /download/i.test(l))).toBe(true);
    });

    it("does not render Edit button for assistant messages", () => {
      const { container } = renderActions({ message: assistantMessage });
      expect(getButtonByLabel(container, "Edit")).toBeNull();
    });

    it("does not render Regenerate button when not the latest assistant message", () => {
      const { container } = renderActions({
        message: assistantMessage,
        isLatestAssistant: false,
        onRegenerate: vi.fn(),
      });
      expect(getButtonByLabel(container, "Regenerate")).toBeNull();
    });

    it("renders Regenerate button for latest assistant message when onRegenerate provided", () => {
      const { container } = renderActions({
        message: assistantMessage,
        isLatestAssistant: true,
        onRegenerate: vi.fn(),
      });
      expect(getButtonByLabel(container, "Regenerate")).not.toBeNull();
    });

    it("renders Read aloud button when TTS is available and onReadAloud provided", () => {
      const { container } = renderActions({
        message: assistantMessage,
        isTtsAvailable: true,
        onReadAloud: vi.fn(),
      });
      expect(getButtonByLabel(container, "Read aloud")).not.toBeNull();
    });

    it("does not render Read aloud button when TTS not available", () => {
      const { container } = renderActions({
        message: assistantMessage,
        isTtsAvailable: false,
        onReadAloud: vi.fn(),
      });
      expect(getButtonByLabel(container, "Read aloud")).toBeNull();
    });

    it("calls onReadAloud with message content when Read aloud is clicked", () => {
      const onReadAloud = vi.fn();
      const { container } = renderActions({
        message: assistantMessage,
        isTtsAvailable: true,
        onReadAloud,
      });
      const btn = getButtonByLabel(container, "Read aloud");
      fireEvent.click(btn!);
      expect(onReadAloud).toHaveBeenCalledWith(assistantMessage.content);
    });

    it("calls downloadMessageAsMarkdown on Download click for plain assistant message", () => {
      const { container } = renderActions({ message: assistantMessage });
      const btn = getButtonByLabel(container, "Download as Markdown");
      expect(btn).not.toBeNull();
      fireEvent.click(btn!);
      expect(mockDownloadMessageAsMarkdown).toHaveBeenCalledWith(assistantMessage, "ora-response");
    });
  });

  describe("Dataset analysis messages", () => {
    it("renders Download report button for dataset message", () => {
      const { container } = renderActions({ message: datasetMessage });
      expect(getButtonByLabel(container, "Download report")).not.toBeNull();
    });

    it("renders Download JSON button for dataset message", () => {
      const { container } = renderActions({ message: datasetMessage });
      expect(getButtonByLabel(container, "Download JSON")).not.toBeNull();
    });

    it("renders Download action plan CSV when actionPlan exists", () => {
      const { container } = renderActions({ message: datasetMessage });
      expect(getButtonByLabel(container, "Download action plan CSV")).not.toBeNull();
    });

    it("does not render Download action plan CSV when no actionPlan", () => {
      const noActionPlan: OraMessage = {
        ...datasetMessage,
        datasetResult: { ...datasetResult, actionPlan: undefined },
      };
      const { container } = renderActions({ message: noActionPlan });
      expect(getButtonByLabel(container, "Download action plan CSV")).toBeNull();
    });

    it("calls downloadDatasetReport on Download report click", () => {
      const { container } = renderActions({ message: datasetMessage });
      const btn = getButtonByLabel(container, "Download report");
      fireEvent.click(btn!);
      expect(mockDownloadDatasetReport).toHaveBeenCalledWith(datasetResult, "ora-dataset-report");
    });

    it("calls downloadDatasetJson on Download JSON click", () => {
      const { container } = renderActions({ message: datasetMessage });
      const btn = getButtonByLabel(container, "Download JSON");
      fireEvent.click(btn!);
      expect(mockDownloadDatasetJson).toHaveBeenCalledWith(datasetResult, "ora-dataset-result");
    });

    it("calls downloadActionPlanCsv on Download action plan CSV click", () => {
      const { container } = renderActions({ message: datasetMessage });
      const btn = getButtonByLabel(container, "Download action plan CSV");
      fireEvent.click(btn!);
      expect(mockDownloadActionPlanCsv).toHaveBeenCalledWith(
        datasetResult.actionPlan,
        "ora-action-plan",
      );
    });
  });

  describe("Image and document analysis messages", () => {
    it("renders Download button for image-analysis messages", () => {
      const { container } = renderActions({ message: imageAnalysisMessage });
      const labels = getAllButtonLabels(container);
      expect(labels.some((l) => /download/i.test(l))).toBe(true);
    });

    it("renders Download button for document-analysis messages", () => {
      const { container } = renderActions({ message: documentAnalysisMessage });
      const labels = getAllButtonLabels(container);
      expect(labels.some((l) => /download/i.test(l))).toBe(true);
    });

    it("renders image analysis download label for image-analysis kind", () => {
      const { container } = renderActions({ message: imageAnalysisMessage });
      expect(getButtonByLabel(container, "Download image analysis")).not.toBeNull();
    });

    it("renders document analysis download label for document-analysis kind", () => {
      const { container } = renderActions({ message: documentAnalysisMessage });
      expect(getButtonByLabel(container, "Download document analysis")).not.toBeNull();
    });

    it("calls downloadMessageAsMarkdown with image filename on click", () => {
      const { container } = renderActions({ message: imageAnalysisMessage });
      const btn = getButtonByLabel(container, "Download image analysis");
      fireEvent.click(btn!);
      expect(mockDownloadMessageAsMarkdown).toHaveBeenCalledWith(
        imageAnalysisMessage,
        "ora-image-analysis",
      );
    });

    it("calls downloadMessageAsMarkdown with document filename on click", () => {
      const { container } = renderActions({ message: documentAnalysisMessage });
      const btn = getButtonByLabel(container, "Download document analysis");
      fireEvent.click(btn!);
      expect(mockDownloadMessageAsMarkdown).toHaveBeenCalledWith(
        documentAnalysisMessage,
        "ora-document-analysis",
      );
    });
  });

  describe("No sensitive data in exports", () => {
    it("copyMessageText is called with the message object (not raw fileRef/imageRef)", async () => {
      const msgWithKind: OraMessage = {
        role: "assistant",
        content: "Here is the analysis of your document.",
        messageKind: "document-analysis",
      };
      const { container } = renderActions({ message: msgWithKind });
      fireEvent.click(getButtonByLabel(container, "Copy")!);
      await waitFor(() => {
        expect(mockCopyMessageText).toHaveBeenCalledWith(msgWithKind);
        const callArg = mockCopyMessageText.mock.calls[0][0] as OraMessage;
        expect(callArg).not.toHaveProperty("fileRef");
        expect(callArg).not.toHaveProperty("imageRef");
      });
    });
  });

  describe("Voice transcript edit works as plain text", () => {
    it("passes voice transcript text to onEdit without modification", () => {
      const voiceTranscriptMessage: OraMessage = {
        role: "user",
        content: "Please build me a weather dashboard with live data",
      };
      const onEdit = vi.fn();
      const { container } = renderActions({ message: voiceTranscriptMessage, onEdit });
      const btn = getButtonByLabel(container, "Edit");
      expect(btn).not.toBeNull();
      fireEvent.click(btn!);
      expect(onEdit).toHaveBeenCalledWith("Please build me a weather dashboard with live data");
    });
  });

  describe("All six Ora phases render without errors", () => {
    it("phase 1 - plain chat assistant message renders", () => {
      expect(() => renderActions({ message: assistantMessage })).not.toThrow();
    });

    it("phase 2 - document analysis message renders", () => {
      expect(() => renderActions({ message: documentAnalysisMessage })).not.toThrow();
    });

    it("phase 3 - dataset analysis message renders", () => {
      expect(() => renderActions({ message: datasetMessage })).not.toThrow();
    });

    it("phase 4 - voice input (user message) renders", () => {
      expect(() => renderActions({ message: userMessage })).not.toThrow();
    });

    it("phase 5 - image analysis message renders", () => {
      expect(() => renderActions({ message: imageAnalysisMessage })).not.toThrow();
    });

    it("phase 6 - builder handoff message renders", () => {
      const handoffMsg: OraMessage = {
        role: "assistant",
        content: "Ready to build your app!",
        handoffCta: true,
      };
      expect(() => renderActions({ message: handoffMsg, isLatestAssistant: true })).not.toThrow();
    });
  });
});
