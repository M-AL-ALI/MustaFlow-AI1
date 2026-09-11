import { describe, expect, it, vi } from "vitest";
import { secretCanInjectAtRuntime, isValidProjectSecretName } from "./project-secret-policy";
// Runtime-load the actual frontend contract without widening the API TypeScript root.
interface DisplayMetadata {
  id: number;
  projectId: number;
  name: string;
  environment: string;
  isPreviewSafe: boolean;
  minRole: string;
}
const { previewSecretDisposition, SECRET_NAME_PATTERN } = await vi.importActual<{
  previewSecretDisposition: (entry: DisplayMetadata, projectId: number) => { eligible: boolean };
  SECRET_NAME_PATTERN: RegExp;
}>("../../../mustaflow/src/pages/projects/components/project-secret-display-model");
const { moduleSecretNames } = await vi.importActual<{
  moduleSecretNames: (projectId: number, secrets: DisplayMetadata[]) => Set<string>;
}>("../../../mustaflow/src/pages/projects/components/module-library-model");
const cases = ["development", "testing", "staging", "production"].flatMap((environment) =>
  [false, true].flatMap((isPreviewSafe) =>
    ["viewer", "member", "admin", "owner"].map((minRole) => ({
      environment,
      isPreviewSafe,
      minRole,
    })),
  ),
);
describe("secret display/server policy contract", () => {
  it.each(cases)("matches saved preview eligibility: %j", (entry) => {
    const metadata = { id: 1, projectId: 101, name: "SYNTHETIC_KEY", ...entry };
    expect(previewSecretDisposition(metadata, 101).eligible).toBe(
      secretCanInjectAtRuntime(entry, "preview"),
    );
    expect(previewSecretDisposition(metadata, 101).eligible).toBe(
      secretCanInjectAtRuntime(entry, "build"),
    );
    expect(moduleSecretNames(101, [metadata]).has(metadata.name)).toBe(
      secretCanInjectAtRuntime(entry, "preview"),
    );
  });
  it.each(["KEY", "_KEY_2", "", "2KEY", "KEY-NAME", "KEY NAME", "KEY=VALUE", "KEY\nOTHER"])(
    "matches variable-name validation for %j",
    (name) => {
      expect(SECRET_NAME_PATTERN.test(name)).toBe(isValidProjectSecretName(name));
    },
  );
});
