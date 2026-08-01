/**
 * Handler-relevant projection of the real PD-1 rerun-7 invoice.paid payload.
 *
 * Source evidence:
 *   C:/Users/mus_1/AppData/Local/Temp/pd13-postfix-d719a8ea/rerun7-item5-fail.json
 *   SHA-256 1db66fc37bce83fba2a1d2a79a2c6683822e515e6c631365c839d801aac8efeb
 *
 * Stripe invoice in_1TzUsYDCzx2AknND0RLOK58U was the paid, immediate
 * Orbit -> Comet proration invoice that triggered the duplicate cycle.
 */
export const RERUN7_SUBSCRIPTION_UPDATE_INVOICE_PAID = {
  id: "in_1TzUsYDCzx2AknND0RLOK58U",
  object: "invoice",
  billing_reason: "subscription_update",
  customer: "cus_UzTYFmo9LsJ7Bz",
  paid: true,
  status: "paid",
  parent: {
    subscription_details: {
      subscription: "sub_1TzUdXDCzx2AknNDyCGR56fn",
      metadata: {
        surface: "nabuflow",
        plan: "comet",
        userId: "user_3HIbv5LHwRz3W7yTFycbZ2NqzfZ",
      },
    },
  },
  lines: {
    data: [
      {
        amount: 4993,
        description: "Remaining time on NabuFlow Comet after 01 Sep 2026",
        parent: { subscription_item_details: { proration: true } },
        period: { start: 1788240821, end: 1790829116 },
      },
      {
        amount: -1997,
        description: "Unused time on NabuFlow Orbit after 01 Sep 2026",
        parent: { subscription_item_details: { proration: true } },
        period: { start: 1788240821, end: 1790829116 },
      },
    ],
  },
  period_start: 1788240821,
  period_end: 1790829116,
} as const;
