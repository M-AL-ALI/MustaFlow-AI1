import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInPlaceBuilderUpgrade } from "./use-in-place-builder-upgrade";

describe("in-place full-stack upgrade recovery", () => {
  it.each(["resolve", "reject"] as const)(
    "clears the original project's pending state after navigating away and back (%s)",
    async (settlement) => {
      let resolveFirst!: () => void;
      let rejectFirst!: (error: Error) => void;
      const apply = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveFirst = resolve;
            rejectFirst = reject;
          }),
      );
      const onSuccess = vi.fn();
      const { result, rerender } = renderHook(
        ({ projectId }) => useInPlaceBuilderUpgrade({ projectId, busy: false, apply, onSuccess }),
        { initialProps: { projectId: 61 } },
      );
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.start();
      });
      expect(result.current.pending).toBe(true);
      rerender({ projectId: 62 });
      await act(async () => {
        if (settlement === "resolve") resolveFirst();
        else rejectFirst(new Error("PRIVATE_PROVIDER_DETAIL"));
        await pending;
      });
      expect(onSuccess).not.toHaveBeenCalled();
      rerender({ projectId: 61 });
      expect(result.current.pending).toBe(false);
      expect(result.current.error).not.toContain("PRIVATE_PROVIDER_DETAIL");
      apply.mockResolvedValueOnce(undefined);
      await act(() => result.current.start());
      expect(apply).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a failed action available, then dismisses only after a successful retry", async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAIL"))
      .mockResolvedValueOnce({});
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useInPlaceBuilderUpgrade({ projectId: 61, busy: false, apply, onSuccess }),
    );
    await act(() => result.current.start());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toContain("Try again");
    expect(result.current.error).not.toContain("PRIVATE_PROVIDER_DETAIL");
    await act(() => result.current.start());
    expect(apply).toHaveBeenNthCalledWith(1, 61);
    expect(apply).toHaveBeenNthCalledWith(2, 61);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("");
  });

  it("does not change builder mode while a build is active", async () => {
    const apply = vi.fn();
    const { result } = renderHook(() =>
      useInPlaceBuilderUpgrade({ projectId: 61, busy: true, apply, onSuccess: vi.fn() }),
    );
    await act(() => result.current.start());
    expect(apply).not.toHaveBeenCalled();
  });

  it("deduplicates rapid clicks and does not dismiss another project's setup card", async () => {
    let resolve!: () => void;
    const apply = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const onSuccess = vi.fn();
    const { result, rerender } = renderHook(
      ({ projectId }) => useInPlaceBuilderUpgrade({ projectId, busy: false, apply, onSuccess }),
      { initialProps: { projectId: 61 } },
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.start();
      void result.current.start();
    });
    expect(apply).toHaveBeenCalledTimes(1);
    rerender({ projectId: 62 });
    await act(async () => {
      resolve();
      await pending;
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.error).toBe("");
    expect(result.current.pending).toBe(false);
  });
});
