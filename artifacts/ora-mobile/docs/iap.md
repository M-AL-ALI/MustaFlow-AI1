# In-App Purchases (iOS)

This document describes how paid Ora plans are intended to work inside the
Ora mobile app. No purchase code ships in the app yet; this is the
agreed approach so a future implementation stays consistent with the server.

## Why IAP is required

Apple requires that digital subscriptions sold inside an iOS app go through
Apple In-App Purchase. The web Stripe checkout used by the website cannot be
surfaced inside the native app, and the app must never link out to an external
purchase flow for digital goods. The mobile app therefore shows plan and usage
state read-only until native IAP is wired up.

## Recommended implementation

Use RevenueCat (the supported payments path for Expo). RevenueCat wraps
StoreKit, works in Expo Go via its preview mode, and avoids hand-rolling
receipt validation.

Product-to-tier mapping (matches the existing server tiers):

- Free — no purchase; default entitlement.
- Core — monthly auto-renewing subscription.
- Wave — monthly auto-renewing subscription.

## Entitlement stays server-owned

Entitlement and quota enforcement remain on the API server, exactly as they are
for the website. The app must not grant access locally based on a StoreKit
receipt alone. The intended flow:

1. User purchases a subscription through RevenueCat / StoreKit.
2. The purchase (or a RevenueCat webhook) is reconciled to the user's account on
   the server, which sets the authoritative tier.
3. The app continues to read plan and usage from the existing endpoints
   (`/api/billing/subscription` and `/api/public-ai/usage`) and renders them.

## Ora isolation

IAP is for Ora plans only. It must never reference, route to, or unlock the AI
Builder. The isolation rules in the project README apply unchanged.
