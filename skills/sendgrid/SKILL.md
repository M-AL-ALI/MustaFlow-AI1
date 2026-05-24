---
name: sendgrid
description: Send transactional email with SendGrid (@sendgrid/mail) — single sends, dynamic templates, and webhooks.
triggers: [sendgrid, @sendgrid, sendgrid mail]
---

# SendGrid skill

Use for high-volume transactional email when the user is already on Twilio / SendGrid or needs enterprise features (dedicated IPs, advanced suppression, EU data residency).

## Setup

1. Verify a sending domain via DNS (DKIM/SPF) in SendGrid.
2. Create an API key with **Mail Send** permission only (least privilege). Store as `SENDGRID_API_KEY`.

## Install

```sh
npm install @sendgrid/mail
```

## Basic send

```ts
import sgMail from "@sendgrid/mail";
sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

await sgMail.send({
  to: "user@example.com",
  from: { email: "hello@acme.com", name: "Acme" },
  subject: "Welcome",
  text: "Welcome to Acme!",
  html: "<p>Welcome to <b>Acme</b>!</p>",
});
```

## Dynamic template

Create a template in the SendGrid dashboard, design with handlebars (`{{name}}`), copy the template ID.

```ts
await sgMail.send({
  to: "user@example.com",
  from: "hello@acme.com",
  templateId: "d-1234567890abcdef",
  dynamicTemplateData: { name: "Ada", confirmUrl: "https://app.acme.com/confirm/xyz" },
});
```

## Do

- Use the `from` object form to set a display name.
- For multiple recipients with personalization, use `personalizations[]` — each gets its own `dynamicTemplateData`.
- Configure **Event Webhook** to track delivered/bounce/open/click.
- Add `asm.groupId` (unsubscribe group ID) for marketing-adjacent mail so unsubscribes work.
- Use sandbox mode (`mail_settings.sandbox_mode.enable = true`) in tests to validate without sending.

## Don't

- Don't reuse a single API key across services — rotate + scope per environment.
- Don't loop `sgMail.send` for bulk — use `sgMail.sendMultiple` or a single send with multiple personalizations.
- Don't send from unverified sender addresses — SendGrid will reject (or land in spam).

## Examples

### Multiple recipients, per-recipient data

```ts
await sgMail.send({
  from: "hello@acme.com",
  templateId: "d-...",
  personalizations: [
    { to: [{ email: "a@x.com" }], dynamicTemplateData: { name: "Ada" } },
    { to: [{ email: "b@x.com" }], dynamicTemplateData: { name: "Bob" } },
  ],
});
```

### Attachment

```ts
import fs from "node:fs/promises";
const buf = await fs.readFile("./receipt.pdf");
await sgMail.send({
  to: "user@example.com",
  from: "hello@acme.com",
  subject: "Your receipt",
  text: "Attached.",
  attachments: [
    {
      content: buf.toString("base64"),
      filename: "receipt.pdf",
      type: "application/pdf",
      disposition: "attachment",
    },
  ],
});
```

### Verifying a webhook

```ts
import { EventWebhook } from "@sendgrid/eventwebhook";
const ew = new EventWebhook();
const pub = ew.convertPublicKeyToECDSA(process.env.SENDGRID_WEBHOOK_KEY!);
app.post("/webhooks/sendgrid", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.header("X-Twilio-Email-Event-Webhook-Signature")!;
  const ts = req.header("X-Twilio-Email-Event-Webhook-Timestamp")!;
  const valid = ew.verifySignature(pub, req.body, sig, ts);
  if (!valid) return res.status(401).end();
  // events = JSON.parse(req.body.toString())
  res.sendStatus(200);
});
```
