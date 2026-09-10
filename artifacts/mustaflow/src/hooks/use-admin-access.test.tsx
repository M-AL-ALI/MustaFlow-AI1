import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  userId: "owner-a",
  signedIn: true,
  fetch: vi.fn(),
}));
vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({ user: { id: state.userId }, isLoaded: true, isSignedIn: state.signedIn }),
}));
vi.mock("@/lib/api-fetch", () => ({ authFetch: state.fetch }));
import { useAdminAccess } from "./use-admin-access";

const response = (isAdmin: unknown, role: unknown = "owner") => ({
  ok: true,
  json: async () => ({ isAdmin, role }),
});
beforeEach(() => {
  state.userId = "owner-a";
  state.signedIn = true;
  state.fetch.mockReset();
});
afterEach(cleanup);

describe("Account-scoped admin menu evidence", () => {
  it("requires a literal server grant, not an email, string, or truthy value", async () => {
    state.fetch.mockResolvedValue(response("true"));
    const { result } = renderHook(useAdminAccess);
    await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    expect(result.current.isAdmin).toBe(false);
  });
  it("hides the old account's role immediately when identity changes", async () => {
    state.fetch.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response(false));
    const { result, rerender } = renderHook(useAdminAccess);
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    state.userId = "regular-b";
    rerender();
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.role).toBeNull();
    await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(2));
    expect(result.current.isAdmin).toBe(false);
  });
  it("aborts and ignores a delayed allowlist response from a previous account", async () => {
    let resolveOld!: (value: unknown) => void;
    state.fetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(response(false));
    const { result, rerender } = renderHook(useAdminAccess);
    const signal = (state.fetch.mock.calls[0][1] as RequestInit).signal!;
    state.userId = "regular-b";
    rerender();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveOld(response(true));
    });
    expect(result.current.isAdmin).toBe(false);
  });
  it("rechecks on focus, fails closed on revocation, and hides on sign-out", async () => {
    state.fetch
      .mockResolvedValueOnce(response(true, "support"))
      .mockResolvedValueOnce(response(false));
    const { result, rerender } = renderHook(useAdminAccess);
    await waitFor(() => expect(result.current.role).toBe("support"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current.isAdmin).toBe(false);
    await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(2));
    state.signedIn = false;
    rerender();
    expect(result.current).toEqual({ isAdmin: false, role: null });
  });
  it("does not request admin access for a signed-out user", () => {
    state.signedIn = false;
    const { result } = renderHook(useAdminAccess);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(result.current.isAdmin).toBe(false);
  });
});
