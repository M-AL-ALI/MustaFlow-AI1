---
name: Ora Mobile web-only purchases (iOS v1)
description: The Expo app must never contain in-app purchase / Stripe / checkout UI; plan management is web-only.
---

## Rule
The Ora Mobile (Expo) app must NOT contain any in-app purchase or billing-action UI:
no "Upgrade to Core/Deep Wave" buttons, no Stripe checkout links, no billing-portal
("Manage billing") link, and no add/setup payment-method flow. Locked-tier and
billing surfaces show only neutral, NON-tappable copy such as
"Manage your Ora plan on the MustaFlow website."

What MUST still work: entitlement/tier display (plan label, status, renewal,
informational tier-feature cards) and the billing-tier vs chat-tier sync
diagnostics, all driven by `getSubscription()` — paid web users keep their unlocked
features on mobile.

**Why:** App Store guideline 3.1.1 forbids selling digital content or linking to
external purchase mechanisms from inside the iOS app. "Web-only purchases for iOS
v1" was the chosen path; native IAP via RevenueCat is a deferred follow-up, not v1.

**How to apply:** Website Stripe billing is out of scope (untouched). The billing
API wrappers may remain as unused exports in `ora-mobile/lib/api.ts`, but nothing in
the Expo UI may import/call them to open checkout/portal/payment setup. If you add
RevenueCat later, that becomes the only sanctioned mobile purchase path.
