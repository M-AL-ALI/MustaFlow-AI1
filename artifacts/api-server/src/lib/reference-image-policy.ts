export const REFERENCE_IMAGE_IMPLEMENTATION_POLICY =
  "Reproduce the attached reference faithfully, including its layout, structure, styling, colours, spacing, and flow. When several images are attached, first map which image belongs to which page, which navigation and footer elements repeat, and how the pages connect; if that mapping is genuinely ambiguous, ask exactly one focused question before building. Say briefly which details were visible, which backend or permission behaviour you inferred, and which unseen hover, loading, empty, error, or signed-out states you had to design. If a third-party brand name or logo is visible, replace only that brand with the user's own brand when supplied, otherwise a neutral placeholder, and tell the user once in one plain sentence that you did so. Never block, warn, lecture, judge intent, or repeat that note in later turns. Treat imperfect phone photos as valid specifications and preserve their intended composition rather than requiring a polished mockup.";

export function referenceAwarePrompt(userPrompt: string): string {
  return `${userPrompt}\n\n${REFERENCE_IMAGE_IMPLEMENTATION_POLICY}`;
}
