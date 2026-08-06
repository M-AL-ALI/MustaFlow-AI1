import type { PreviewGrantClaims } from "../src/preview-grant";

/**
 * Fixed ES256 compatibility vector. These keys are public test data only and
 * must never be used outside tests. The compact signature is raw IEEE P1363
 * (r || s), not ASN.1/DER.
 */
export const PREVIEW_GRANT_COMPATIBILITY_VECTOR = {
  privateKeyPem: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgZqQSR1D+CC69JD0Q
g0cVWWv9GV9xRDwJACmeFbbvu9ihRANCAARccmVKOQxtA98n4Y1H6wXtU44Zh9vj
eLbrsF4RiLGT1LD3jL0agmggLIq0aXXeIO53j5U1HjWVKvOJTy3YB4on
-----END PRIVATE KEY-----
`,
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXHJlSjkMbQPfJ+GNR+sF7VOOGYfb
43i267BeEYixk9Sw94y9GoJoICyKtGl13iDud4+VNR41lSrziU8t2AeKJw==
-----END PUBLIC KEY-----
`,
  claims: {
    v: 1,
    iss: "nabuflow-api",
    aud: "https://nabuflow-runtime-staging.mustafa-alali74.workers.dev",
    sub: "nrf-e919a75364398a44-p424242-preview-primary",
    port: 8080,
    iat: 1_785_859_200,
    exp: 1_785_859_500,
    jti: "preview-vector-jti-0001",
  } satisfies PreviewGrantClaims,
  headerJson: '{"alg":"ES256","typ":"NABUFLOW_PREVIEW_GRANT"}',
  claimsJson:
    '{"v":1,"iss":"nabuflow-api","aud":"https://nabuflow-runtime-staging.mustafa-alali74.workers.dev","sub":"nrf-e919a75364398a44-p424242-preview-primary","port":8080,"iat":1785859200,"exp":1785859500,"jti":"preview-vector-jti-0001"}',
  signingInput:
    "eyJhbGciOiJFUzI1NiIsInR5cCI6Ik5BQlVGTE9XX1BSRVZJRVdfR1JBTlQifQ.eyJ2IjoxLCJpc3MiOiJuYWJ1Zmxvdy1hcGkiLCJhdWQiOiJodHRwczovL25hYnVmbG93LXJ1bnRpbWUtc3RhZ2luZy5tdXN0YWZhLWFsYWxpNzQud29ya2Vycy5kZXYiLCJzdWIiOiJucmYtZTkxOWE3NTM2NDM5OGE0NC1wNDI0MjQyLXByZXZpZXctcHJpbWFyeSIsInBvcnQiOjgwODAsImlhdCI6MTc4NTg1OTIwMCwiZXhwIjoxNzg1ODU5NTAwLCJqdGkiOiJwcmV2aWV3LXZlY3Rvci1qdGktMDAwMSJ9",
  signatureHex:
    "021343ac2f8afa184f2839dcbdc5d278a9c484f7cbfa170aa168b88b1e6bfca7eb3eb25ccf3e66c694bd10dfc4330d6ca66002fbc8dd544dcdad0121882cf1fd",
  token:
    "eyJhbGciOiJFUzI1NiIsInR5cCI6Ik5BQlVGTE9XX1BSRVZJRVdfR1JBTlQifQ.eyJ2IjoxLCJpc3MiOiJuYWJ1Zmxvdy1hcGkiLCJhdWQiOiJodHRwczovL25hYnVmbG93LXJ1bnRpbWUtc3RhZ2luZy5tdXN0YWZhLWFsYWxpNzQud29ya2Vycy5kZXYiLCJzdWIiOiJucmYtZTkxOWE3NTM2NDM5OGE0NC1wNDI0MjQyLXByZXZpZXctcHJpbWFyeSIsInBvcnQiOjgwODAsImlhdCI6MTc4NTg1OTIwMCwiZXhwIjoxNzg1ODU5NTAwLCJqdGkiOiJwcmV2aWV3LXZlY3Rvci1qdGktMDAwMSJ9.AhNDrC-K-hhPKDncvcXSeKnEhPfL-hcKoWi4ix5r_KfrPrJczz5mxpS9EN_EMw1spmAC-8jdVE3NrQEhiCzx_Q",
} as const;
