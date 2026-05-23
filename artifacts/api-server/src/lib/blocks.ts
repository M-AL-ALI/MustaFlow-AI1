import { parseDocument } from "htmlparser2";
import { createHash } from "node:crypto";

// Top-level HTML elements treated as "blocks" the user can reorder/move.
// We also opt in any element with a `data-block="…"` attribute on any level.
const BLOCK_TAGS = new Set([
  "header",
  "nav",
  "main",
  "section",
  "article",
  "aside",
  "footer",
  "form",
]);

export type Block = {
  id: string;
  tag: string;
  label: string;
  textSnippet: string;
  /** Inclusive start char index in the original HTML. */
  startIndex: number;
  /** Inclusive end char index (position of '>' in the closing tag). */
  endIndex: number;
};

export type ParseResult = {
  blocks: Block[];
  parseOk: boolean;
};

type LooseNode = {
  type: string;
  name?: string;
  data?: string;
  children?: LooseNode[];
  attribs?: Record<string, string>;
  startIndex?: number | null;
  endIndex?: number | null;
};

function isBlockElement(node: LooseNode): boolean {
  if (node.type !== "tag" || !node.name) return false;
  if (BLOCK_TAGS.has(node.name)) return true;
  if (node.attribs && typeof node.attribs["data-block"] === "string") return true;
  return false;
}

function collectText(node: LooseNode, out: { s: string }): void {
  if (out.s.length >= 160) return;
  if (node.type === "text" && typeof node.data === "string") {
    out.s += node.data;
    return;
  }
  if (node.children) {
    for (const c of node.children) {
      collectText(c, out);
      if (out.s.length >= 160) return;
    }
  }
}

function getTextSnippet(node: LooseNode): string {
  const acc = { s: "" };
  collectText(node, acc);
  return acc.s.replace(/\s+/g, " ").trim().slice(0, 80);
}

function hashId(parts: string[]): string {
  return "blk_" + createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

function findFirst(nodes: LooseNode[], name: string): LooseNode | null {
  for (const n of nodes) {
    if (n.type === "tag" && n.name === name) return n;
    if (n.children) {
      const found = findFirst(n.children, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Parse an HTML document and return its top-level <body> blocks with stable
 * IDs derived from tag name + leading text content. Same-shaped duplicates
 * are disambiguated with a numeric suffix so IDs stay unique within a file.
 */
export function parseBlocks(html: string): ParseResult {
  try {
    const doc = parseDocument(html, {
      withStartIndices: true,
      withEndIndices: true,
    }) as unknown as { children: LooseNode[] };

    const body = findFirst(doc.children, "body");
    // If there's no <body> wrapper, treat the document root as the container
    // so single-snippet HTML fragments can still be parsed.
    const container = body ?? { children: doc.children, type: "tag" };
    const children: LooseNode[] = container.children ?? [];

    const blocks: Block[] = [];
    const seenIdCounts = new Map<string, number>();

    for (const child of children) {
      if (!isBlockElement(child)) continue;
      if (child.startIndex == null || child.endIndex == null) continue;
      const text = getTextSnippet(child);
      const baseId = hashId([child.name ?? "el", text]);
      const n = seenIdCounts.get(baseId) ?? 0;
      seenIdCounts.set(baseId, n + 1);
      const id = n === 0 ? baseId : `${baseId}_${n}`;
      blocks.push({
        id,
        tag: child.name ?? "div",
        label: text || (child.name ?? "block"),
        textSnippet: text,
        startIndex: child.startIndex,
        endIndex: child.endIndex,
      });
    }

    return { blocks, parseOk: true };
  } catch {
    return { blocks: [], parseOk: false };
  }
}

/**
 * Reorder blocks within a single HTML document.
 *
 * `newOrder` is a list of block IDs in the desired final order. Any current
 * block whose ID is not present in `newOrder` is appended at the end in its
 * original relative order — this means a partial reorder request (e.g. just
 * "move block X above block Y") is safe even if the client omits the others.
 *
 * Preserves the original whitespace/newlines between blocks by keeping the
 * inter-block "gaps" intact and reassociating them with the new positions.
 * Returns the original HTML unchanged when parsing fails or the order is
 * already correct.
 */
export function reorderBlocks(html: string, newOrder: string[]): string {
  const { blocks, parseOk } = parseBlocks(html);
  if (!parseOk || blocks.length === 0) return html;

  const originalIds = blocks.map((b) => b.id);
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of newOrder) {
    if (originalIds.includes(id) && !seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }
  for (const id of originalIds) {
    if (!seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }

  if (orderedIds.join("|") === originalIds.join("|")) return html;

  const prefix = html.slice(0, blocks[0].startIndex);
  const suffix = html.slice(blocks[blocks.length - 1].endIndex + 1);
  // Capture each block's HTML and the gap that originally followed it.
  const blockHtml = new Map<string, string>();
  for (const b of blocks) {
    blockHtml.set(b.id, html.slice(b.startIndex, b.endIndex + 1));
  }
  const gaps: string[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    gaps.push(html.slice(blocks[i].endIndex + 1, blocks[i + 1].startIndex));
  }

  let out = prefix;
  for (let i = 0; i < orderedIds.length; i++) {
    out += blockHtml.get(orderedIds[i])!;
    if (i < orderedIds.length - 1) {
      out += gaps[i] ?? "\n";
    }
  }
  out += suffix;
  return out;
}

/**
 * Remove a block from an HTML document and return both the rewritten HTML and
 * the extracted block snippet (for transfer to another file). Trailing/leading
 * whitespace adjacent to the block is consumed when it consists only of
 * whitespace, so the surrounding document doesn't accumulate blank lines.
 */
export function removeBlock(
  html: string,
  blockId: string,
): { html: string; removed: string | null } {
  const { blocks, parseOk } = parseBlocks(html);
  if (!parseOk) return { html, removed: null };
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return { html, removed: null };

  const block = blocks[idx];
  const next = blocks[idx + 1];
  const prev = blocks[idx - 1];

  let removeStart = block.startIndex;
  let removeEnd = block.endIndex + 1;

  if (next) {
    const gap = html.slice(removeEnd, next.startIndex);
    if (/^\s*$/.test(gap)) removeEnd = next.startIndex;
  } else if (prev) {
    const gap = html.slice(prev.endIndex + 1, block.startIndex);
    if (/^\s*$/.test(gap)) removeStart = prev.endIndex + 1;
  }

  const removedHtml = html.slice(block.startIndex, block.endIndex + 1);
  const newHtml = html.slice(0, removeStart) + html.slice(removeEnd);
  return { html: newHtml, removed: removedHtml };
}

/**
 * Insert a block snippet into an HTML document either before a target block
 * (when `beforeBlockId` is given and matches), or appended after the last
 * existing block. If the document has no blocks to anchor against, returns
 * the original HTML unchanged — callers should treat this as a no-op rather
 * than risk corrupting an unstructured document.
 */
export function insertBlock(
  html: string,
  beforeBlockId: string | null,
  blockSnippet: string,
): string {
  const trimmed = blockSnippet.trim();
  if (!trimmed) return html;
  const { blocks, parseOk } = parseBlocks(html);
  if (!parseOk || blocks.length === 0) return html;

  if (beforeBlockId) {
    const target = blocks.find((b) => b.id === beforeBlockId);
    if (target) {
      // Mirror the surrounding indentation of the target line so the inserted
      // block doesn't appear flush-left in an indented document.
      const lineStart = html.lastIndexOf("\n", target.startIndex - 1) + 1;
      const indent = html.slice(lineStart, target.startIndex).match(/^[ \t]*/)?.[0] ?? "";
      return (
        html.slice(0, target.startIndex) + trimmed + "\n" + indent + html.slice(target.startIndex)
      );
    }
  }

  // Append after the last block, preserving its trailing indentation.
  const last = blocks[blocks.length - 1];
  const lineStart = html.lastIndexOf("\n", last.startIndex - 1) + 1;
  const indent = html.slice(lineStart, last.startIndex).match(/^[ \t]*/)?.[0] ?? "";
  return html.slice(0, last.endIndex + 1) + "\n" + indent + trimmed + html.slice(last.endIndex + 1);
}
