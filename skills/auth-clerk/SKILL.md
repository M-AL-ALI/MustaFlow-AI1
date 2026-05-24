---
name: auth-clerk
description: Add user authentication using Clerk (sign-in, sign-up, session, protected routes).
triggers: [auth, login, sign in, sign up, account, user, clerk, authentication, protected route]
---

# Clerk Auth skill

Use this when the user asks for login, sign-up, accounts, user profiles, or
"protect this page".

## Required secrets

| Secret                       | Where            |
| ---------------------------- | ---------------- |
| `CLERK_SECRET_KEY`           | Server only      |
| `CLERK_PUBLISHABLE_KEY`      | Server (Express) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Vite frontend    |

Add them to `integrationsNeeded` so the user is prompted to set them.

## Frontend (React + Vite)

```tsx
// src/main.tsx
import { ClerkProvider } from "@clerk/clerk-react";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!PUBLISHABLE_KEY) throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");

createRoot(document.getElementById("root")!).render(
  <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
    <App />
  </ClerkProvider>,
);
```

- Use `<SignedIn>` / `<SignedOut>` to gate UI.
- Use `<UserButton />` in the header for the avatar + sign-out menu.
- Use `useUser()` to read the current user; `useAuth()` for `isSignedIn`, `getToken()`.
- Routing: place `<SignIn />` at `/sign-in/*` and `<SignUp />` at `/sign-up/*` (note the trailing `/*` — Clerk needs it for sub-routes).

## Backend (Express)

```ts
import { clerkMiddleware, getAuth, requireAuth } from "@clerk/express";

app.use(clerkMiddleware());

app.get("/api/me", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  res.json({ userId });
});
```

## Do

- Server-side: always re-check `getAuth(req).userId` in protected routes. Don't trust the client.
- Use Clerk session cookies for browser apps; the cookie is set automatically — do **not** send `Authorization: Bearer` headers from the browser.
- Theme Clerk components to match the app: pass `appearance={{ baseTheme: dark }}` from `@clerk/themes` when the rest of the UI is dark.

## Don't

- Do not store passwords yourself, ever.
- Do not call `getToken()` from the browser unless calling a non-Clerk service that needs a JWT.
- Do not expose `CLERK_SECRET_KEY` to the frontend.
- Do not hand-roll session cookies, JWT verification, or password hashing.

## Examples

### Protect a page (React)

```tsx
import { SignedIn, SignedOut, RedirectToSignIn, UserButton } from "@clerk/clerk-react";

export default function Dashboard() {
  return (
    <>
      <SignedIn>
        <header className="flex justify-end p-4">
          <UserButton />
        </header>
        <main>Welcome back!</main>
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}
```

### Server-side guard (Express)

```ts
import { clerkMiddleware, getAuth } from "@clerk/express";

app.use(clerkMiddleware());

app.get("/api/me", (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ userId });
});
```
