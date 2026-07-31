/** Keep configured price and settled charge semantically distinct in tool observations. */
export function creativeChargeFields(
  estimatedCredits: number,
  actualCreditsCharged: number,
): { estimatedCredits: number; creditsCharged: number } {
  return {
    estimatedCredits,
    creditsCharged: Math.max(0, actualCreditsCharged),
  };
}
