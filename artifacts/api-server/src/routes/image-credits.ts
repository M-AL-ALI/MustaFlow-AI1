/**
 * Re-exported credit helpers for image generation — Phase 9A-1.
 *
 * This thin wrapper re-exports deductCreditsAtomic and refundCredits with the
 * credit cost table for image quality tiers, keeping the image-generation-jobs
 * module decoupled from the full credits route file.
 */
export { deductCreditsAtomic, refundCredits } from "./credits";

export const IMAGE_CREDIT_COSTS: Record<string, number> = {
  draft: 1,
  standard: 3,
  high: 6,
};

export const IMAGE_RATE_LIMIT_PER_HOUR = Number(process.env.IMAGE_RATE_LIMIT_PER_HOUR ?? "10");

export const IMAGE_DAILY_LIMIT = Number(process.env.IMAGE_DAILY_LIMIT ?? "20");
