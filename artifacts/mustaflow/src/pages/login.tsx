import { Redirect } from "wouter";

// The /login route is kept for backward compatibility.
// Real authentication is handled at /sign-in via Clerk.
export default function LoginPage() {
  return <Redirect to="/sign-in" />;
}
