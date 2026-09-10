import { describe, expect, it, vi } from "vitest";
import {
  createProjectReviewAccountFence,
  type ProjectReviewClerk,
} from "./project-review-account-fence";

type Listener = Parameters<ProjectReviewClerk["addListener"]>[0];

function source() {
  const listeners = new Set<Listener>();
  const stop = vi.fn();
  const clerk: ProjectReviewClerk = {
    loaded: true,
    user: { id: "account-a" },
    addListener: vi.fn((listener: Listener) => {
      listeners.add(listener);
      listener({ user: clerk.user });
      return () => {
        stop();
        listeners.delete(listener);
      };
    }),
  };
  return {
    clerk,
    listeners,
    stop,
    emit(ownerId: string | null) {
      for (const listener of [...listeners]) {
        listener({ user: ownerId ? { id: ownerId } : null });
      }
    },
  };
}

describe("project review Clerk principal fence", () => {
  it("accepts the current loaded principal and repeated snapshots of that principal", () => {
    const sdk = source();
    const invalidate = vi.fn();
    const fence = createProjectReviewAccountFence("account-a", invalidate, () => sdk.clerk);
    sdk.emit("account-a");
    expect(fence.isCurrent()).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    fence.dispose();
  });

  it("rejects a changed SDK principal before a listener notification is delivered", () => {
    const sdk = source();
    const invalidate = vi.fn();
    const fence = createProjectReviewAccountFence("account-a", invalidate, () => sdk.clerk);
    sdk.clerk.user = { id: "account-b" };
    expect(fence.isCurrent()).toBe(false);
    sdk.clerk.user = { id: "account-a" };
    expect(fence.isCurrent()).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    fence.dispose();
  });

  it("latches an A-to-B-to-A notification sequence even while the SDK getter still shows A", () => {
    const sdk = source();
    const invalidate = vi.fn();
    const fence = createProjectReviewAccountFence("account-a", invalidate, () => sdk.clerk);
    sdk.emit("account-b");
    sdk.emit("account-a");
    expect(sdk.clerk.user?.id).toBe("account-a");
    expect(fence.isCurrent()).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    fence.dispose();
  });

  it("rejects sign-out and SDK loading transitions", () => {
    const signedOut = source();
    const first = createProjectReviewAccountFence("account-a", vi.fn(), () => signedOut.clerk);
    signedOut.emit(null);
    expect(first.isCurrent()).toBe(false);
    first.dispose();
    const loading = source();
    const second = createProjectReviewAccountFence("account-a", vi.fn(), () => loading.clerk);
    loading.clerk.loaded = false;
    expect(second.isCurrent()).toBe(false);
    second.dispose();
  });

  it("rejects a replacement Clerk instance even with the same user ID", () => {
    const first = source();
    const second = source();
    let current = first.clerk;
    const fence = createProjectReviewAccountFence("account-a", vi.fn(), () => current);
    current = second.clerk;
    expect(fence.isCurrent()).toBe(false);
    fence.dispose();
    expect(first.stop).toHaveBeenCalledOnce();
  });

  it("fails closed when the principal or its subscription is unavailable", () => {
    const absent = createProjectReviewAccountFence("account-a", vi.fn(), () => undefined);
    expect(absent.isCurrent()).toBe(false);
    absent.dispose();
    const sdk = source();
    sdk.clerk.addListener = () => {
      throw new Error("subscription unavailable");
    };
    const unavailable = createProjectReviewAccountFence("account-a", vi.fn(), () => sdk.clerk);
    expect(unavailable.isCurrent()).toBe(false);
    unavailable.dispose();
    const unreadable = createProjectReviewAccountFence("account-a", vi.fn(), () => {
      throw new Error("principal unavailable");
    });
    expect(unreadable.isCurrent()).toBe(false);
    unreadable.dispose();
  });

  it("rechecks the principal after registering its listener", () => {
    const sdk = source();
    sdk.clerk.addListener = () => {
      sdk.clerk.user = { id: "account-b" };
      return sdk.stop;
    };
    const fence = createProjectReviewAccountFence("account-a", vi.fn(), () => sdk.clerk);
    expect(fence.isCurrent()).toBe(false);
    fence.dispose();
    expect(sdk.stop).toHaveBeenCalledOnce();
  });

  it("disposes idempotently and ignores callbacks already captured by an emitter", () => {
    const sdk = source();
    const invalidate = vi.fn();
    const fence = createProjectReviewAccountFence("account-a", invalidate, () => sdk.clerk);
    const captured = [...sdk.listeners][0];
    fence.dispose();
    fence.dispose();
    captured({ user: { id: "account-b" } });
    expect(fence.isCurrent()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalledOnce();
    expect(sdk.listeners.size).toBe(0);
  });
});
