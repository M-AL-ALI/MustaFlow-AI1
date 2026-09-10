export const IMAGE_FAILURE_FALLBACK =
  "The image could not be created. Please try again. If this continues, contact NabuFlow support with the image reference.";

/** Presentation only. Retain provider diagnostics in the service, never in customer instructions. */
export function presentImageFailure(
  value: unknown,
  context: { code?: unknown; status?: number } = {},
): string {
  if (context.code === "asset_storage_reconciliation_required") {
    return "Your storage total is still being verified. Please try again after storage reconciliation finishes.";
  }
  if (context.code === "asset_storage_unavailable" || value === "Storage allowance unavailable") {
    return "Your storage allowance could not be verified. Please retry later or contact NabuFlow support.";
  }
  // Only this exact first-party admission response establishes insufficient customer credits.
  if (context.status === 402 && value === "Insufficient credits") {
    return "There are not enough NabuFlow image credits for this request. Review Billing & Usage before trying again.";
  }
  if (context.status === 401)
    return "Your session could not be verified. Sign in again before requesting an image.";
  if (context.status === 404) return "This image or project is unavailable to your account.";
  if (context.status === 400 || context.status === 422) {
    return "This image request could not be accepted. Review the prompt, selected image, and generation settings before trying again.";
  }
  if (context.status === 429 && value === "Monthly image limit reached") {
    return "Your monthly NabuFlow image limit has been reached. Review Billing & Usage for your current allowance.";
  }
  if (context.status === 429 && value === "Rate limit exceeded") {
    return "Too many image requests were made. Wait before trying again.";
  }
  return IMAGE_FAILURE_FALLBACK;
}
