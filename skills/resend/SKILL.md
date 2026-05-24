---
name: resend
description: Send transactional email with Resend — domain-verified sending and React Email templates.
triggers: [resend, email, transactional email, react email]
---

# Resend skill

Use to send transactional email (welcome, password reset, receipts). Resend's API is modern, has a friendly free tier, and works great with **React Email** for templating.

## Setup

1. Sign up, verify a sending domain (`hello@yourdomain.com`) — required for production.
2. Create an API key; store as `RESEND_API_KEY` env var.

## Install

```sh
npm install resend
# optional: React Email templates
npm install @react-email/components react-email
```

## Server send

```ts
import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);

const { data, error } = await resend.emails.send({
  from: "Acme <hello@acme.com>",
  to: ["user@example.com"],
  subject: "Welcome to Acme",
  html: "<p>Thanks for signing up!</p>",
});

if (error) throw error;
console.log("sent", data?.id);
```

## React Email template

```tsx
// emails/welcome.tsx
import { Html, Head, Body, Container, Heading, Text, Button } from "@react-email/components";

export function Welcome({ name, url }: { name: string; url: string }) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "system-ui", background: "#f6f6f6" }}>
        <Container style={{ background: "white", padding: 24, borderRadius: 8 }}>
          <Heading>Welcome, {name}!</Heading>
          <Text>Click below to confirm your email.</Text>
          <Button
            href={url}
            style={{ background: "#000", color: "white", padding: "12px 16px", borderRadius: 6 }}
          >
            Confirm email
          </Button>
        </Container>
      </Body>
    </Html>
  );
}
```

```ts
import { render } from "@react-email/render";
import { Welcome } from "./emails/welcome";

await resend.emails.send({
  from: "Acme <hello@acme.com>",
  to: user.email,
  subject: "Welcome!",
  html: await render(<Welcome name={user.name} url={confirmUrl} />),
});
```

## Do

- Always send from a verified domain — using gmail.com or unverified addresses lands in spam.
- Include a plain-text `text:` body alongside `html:` for deliverability.
- Implement webhooks (`resend.com/docs/dashboard/webhooks`) to track delivered/bounced/opened.
- Use `tags` / `headers` to group emails for analytics.
- Test in dev with `onboarding@resend.dev` (Resend's safe sandbox sender).

## Don't

- Don't loop `resend.emails.send` for bulk — use `resend.batch.send([...])` (up to 100 per call).
- Don't expose the API key client-side.
- Don't send marketing email under "transactional" — that's a CAN-SPAM problem.

## Examples

### Batch send

```ts
await resend.batch.send([
  { from: "Acme <hi@acme.com>", to: ["a@x.com"], subject: "Update", html: "<p>Hi A</p>" },
  { from: "Acme <hi@acme.com>", to: ["b@x.com"], subject: "Update", html: "<p>Hi B</p>" },
]);
```

### Password reset

```ts
const token = crypto.randomUUID();
await db.update(users).set({ resetToken: token }).where(eq(users.id, user.id));
const url = `https://app.acme.com/reset?token=${token}`;
await resend.emails.send({
  from: "Acme Security <security@acme.com>",
  to: user.email,
  subject: "Reset your password",
  html: `<p>Click <a href="${url}">here</a> to reset. Link expires in 30 minutes.</p>`,
});
```
