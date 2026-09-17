/** Shared by initial generation and both bounded sealed-capability repair paths. */
export const ZERO_SEALED_BROWSER_REQUEST_GUIDANCE =
  "Preserve the requested browser interactions without bypassing sealed capability checks. " +
  "Server-side fetch and dynamic browser fetch targets are unsupported. Inline browser scripts " +
  "inside server source are not exempt from the fetch restriction. The existing public/ exception " +
  "permits only literal same-origin fetch paths; it does not make source-only assets available in " +
  "the compiler-emitted artifact. Do not move code into an unserved public/ file, hide calls behind " +
  "aliases/eval, switch network libraries, or request broader egress. " +
  "For an existing form-based app, preserve native same-origin form submission and its existing " +
  "routes, using Post/Redirect/Get where appropriate. Keep a matching browser draft on submit, " +
  "validation failure, network failure, and unrelated navigation. Clear it only on explicit " +
  "discard or a server-confirmed successful save bound to that exact submission, signed-in user, " +
  "note, and browser tab. Any redirect, an unchanged URL, or a mutable author field is not proof " +
  "of a successful save or user identity. A success acknowledgement must be issued only after " +
  "the actual save succeeds; never acknowledge a failed write or trust a client-supplied success " +
  "flag. Keep draft contents out of URLs, logs, telemetry, and server requests before Save. " +
  "Keep storage failures non-fatal and preserve the requested languages, routes, authentication, " +
  "schema, records, and visual behavior. If those requirements cannot be satisfied with available " +
  "capabilities, report the specific blocker instead of removing functionality or claiming success.";
