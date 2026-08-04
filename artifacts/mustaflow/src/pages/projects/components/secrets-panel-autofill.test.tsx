import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsPanel } from "../../dev-workspace/components/secrets-panel";

const createSecret = { isPending: false, mutate: vi.fn() };

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListSecretsQueryKey: (projectId: number) => ["secrets", projectId],
  useCreateSecret: () => createSecret,
  useDeleteSecret: () => ({ isPending: false, mutate: vi.fn() }),
  useListSecrets: () => ({ data: [], isLoading: false }),
}));

describe("SecretsPanel new-secret form", () => {
  beforeEach(() => {
    createSecret.mutate.mockClear();
  });

  it("starts empty and exposes autofill-resistant name and value inputs", async () => {
    const user = userEvent.setup();
    render(<SecretsPanel projectId={49} />);

    await user.click(screen.getByRole("button", { name: "Add secret" }));

    const nameInput = screen.getByLabelText("Name");
    const valueInput = screen.getByLabelText("Value");

    expect(nameInput).toHaveValue("");
    expect(nameInput).toHaveAttribute("name", "nabuflow-secret-identifier");
    expect(nameInput).toHaveAttribute("autocomplete", "off");
    expect(nameInput).toHaveAttribute("data-1p-ignore", "true");
    expect(valueInput).toHaveValue("");
    expect(valueInput).toHaveAttribute("name", "nabuflow-secret-material");
    expect(valueInput).toHaveAttribute("autocomplete", "new-password");
    expect(valueInput).toHaveAttribute("data-1p-ignore", "true");
    expect(valueInput).toHaveAttribute("readonly");

    await user.click(valueInput);
    expect(valueInput).not.toHaveAttribute("readonly");
    await user.type(valueInput, "test-value");
    expect(valueInput).toHaveValue("test-value");
  });
});
