---
name: PDFKit page numbers — bufferPages pattern
description: How to safely add page numbers in PDFKit without triggering recursive stack overflow via pageAdded event
---

# PDFKit page numbers — use bufferPages, not pageAdded

## The Rule

Never call `doc.text()` (or any layout-affecting method) inside a `pageAdded` event listener.

## Why

`doc.text()` can internally call `continueOnNewPage()` → `doc.addPage()` → emits `pageAdded` again → listener fires again → infinite recursion → `RangeError: Maximum call stack size exceeded` deep in pdfkit/lib/object.js.

## How to Apply

Use `bufferPages: true` when constructing the document, write all content, then stamp page numbers at the end:

```typescript
const doc = new PDFDocument({ size: "A4", bufferPages: true });

// ... write all content ...

// Stamp page numbers after all content is buffered
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(range.start + i);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#9CA3AF")
    .text(`Page ${i + 1} of ${range.count}`, MARGIN, doc.page.height - 40, {
      width: CONTENT_W,
      align: "center",
    });
}
doc.end();
```

**Why bufferPages:** Keeps all pages in memory until `doc.end()`, enabling `switchToPage()` for post-hoc edits. Without it, pages are flushed immediately and can't be revisited.
