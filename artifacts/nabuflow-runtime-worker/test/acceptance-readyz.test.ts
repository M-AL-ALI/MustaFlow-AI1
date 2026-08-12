import { describe, expect, it } from "vitest";
import worker, { ACCEPTANCE_READINESS_PATH } from "../src/acceptance-provisioner-index";
import type { AcceptanceProvisionerBindings } from "../src/acceptance-provisioner-model";

const ACCEPTANCE_ORIGIN = "https://acceptance.invalid";

function validKek(): string {
  const bytes = new Uint8Array(32);
  bytes.fill(7);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  bytes.fill(0);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function environment(input: {
  gate: "true" | "false";
  kek?: string;
}): AcceptanceProvisionerBindings {
  return {
    ACCEPTANCE_STAGING_ENABLED: input.gate,
    ...(input.kek === undefined ? {} : { ACCEPTANCE_VAULT_KEK: input.kek }),
  } as unknown as AcceptanceProvisionerBindings;
}

async function readiness(input: {
  gate: "true" | "false";
  kek?: string;
}): Promise<{ response: Response; text: string; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`${ACCEPTANCE_ORIGIN}${ACCEPTANCE_READINESS_PATH}`),
    environment(input),
  );
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("acceptance provisioner readiness", () => {
  for (const gate of ["false", "true"] as const) {
    for (const specimen of [
      { label: "absent", value: undefined, expected: "absent" },
      { label: "malformed", value: "not-a-valid-acceptance-kek", expected: "malformed" },
      { label: "valid", value: validKek(), expected: "valid" },
    ] as const) {
      it(`reports gate=${gate} and kek=${specimen.label} without leaking bindings`, async () => {
        const result = await readiness({ gate, kek: specimen.value });

        expect(result.response.status).toBe(200);
        expect(result.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
        expect(result.body).toEqual({
          ready: true,
          gate: gate === "true" ? "enabled" : "disabled",
          kek: specimen.expected,
        });
        expect(Object.keys(result.body)).toEqual(["ready", "gate", "kek"]);
        expect(result.text).not.toContain("ACCEPTANCE_VAULT_KEK");
        expect(result.text).not.toContain("ACCEPTANCE_STAGING_ENABLED");
        if (specimen.value !== undefined) expect(result.text).not.toContain(specimen.value);
      });
    }
  }

  it("preserves disabled-gate lease behavior and does not intercept non-GET readiness calls", async () => {
    for (const { path, method } of [
      { path: "/_nabuflow/acceptance/v1/leases", method: "POST" },
      { path: ACCEPTANCE_READINESS_PATH, method: "POST" },
    ]) {
      const response = await worker.fetch(
        new Request(`${ACCEPTANCE_ORIGIN}${path}`, { method }),
        environment({ gate: "false", kek: validKek() }),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "acceptance_lease_not_found",
        retryable: false,
      });
    }
  });

  it("preserves enabled-gate authentication behavior for lease and non-GET readiness calls", async () => {
    for (const { path, method } of [
      { path: "/_nabuflow/acceptance/v1/leases", method: "POST" },
      { path: ACCEPTANCE_READINESS_PATH, method: "POST" },
    ]) {
      const response = await worker.fetch(
        new Request(`${ACCEPTANCE_ORIGIN}${path}`, { method }),
        environment({ gate: "true", kek: validKek() }),
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        code: "acceptance_unauthorized",
        retryable: false,
      });
    }
  });
});
