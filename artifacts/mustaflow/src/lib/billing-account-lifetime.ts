import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { authFetch } from "@/lib/api-fetch";
import { useClerkUser } from "@/lib/clerk-safe";
import {
  createProjectReviewAccountFence,
  type ProjectReviewClerk,
} from "@/lib/project-review-account-fence";

export type BillingAccount = {
  userId: string;
  key: number;
  clerk: ProjectReviewClerk;
  invalidate: () => void;
};

export type BillingAccountLifetime = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  assertCurrent: () => void;
  wait: (milliseconds: number) => Promise<boolean>;
  dispose: () => void;
};

function devAccountId(): string | null {
  // Match App.tsx's existing addInitScript contract, which is absent in production.
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const id = (window as unknown as { __E2E_TEST_USER__?: string }).__E2E_TEST_USER__;
  return typeof id === "string" && id.length > 0 ? id : null;
}

const devClerk: ProjectReviewClerk = {
  get loaded() {
    return devAccountId() !== null;
  },
  get user() {
    const id = devAccountId();
    return id ? { id } : null;
  },
  addListener(listener) {
    // The existing E2E principal is injected before app startup.
    listener({ user: devClerk.user });
    return () => {};
  },
};

function readBillingClerk(): ProjectReviewClerk | undefined {
  if (typeof window === "undefined") return undefined;
  if (devAccountId()) return devClerk;
  return (window as Window & { Clerk?: ProjectReviewClerk }).Clerk;
}

let nextAccountKey = 0;

/** React owns presentation; the SDK snapshot and listener own account identity. */
export function useBillingAccount(): BillingAccount | null {
  // Also rerender when Clerk first loads or its context changes.
  useClerkUser();
  const clerk = readBillingClerk();
  const store = useMemo(() => {
    let snapshot: BillingAccount | null = null;
    let unavailable = false;
    let notifyChange = () => {};
    const observe = (id: string | null): void => {
      if (snapshot?.userId === id || (!snapshot && !id)) return;
      const next: BillingAccount | null =
        id && clerk
          ? {
              userId: id,
              key: ++nextAccountKey,
              clerk,
              invalidate() {
                if (snapshot !== next) return;
                snapshot = null;
                getSnapshot();
                notifyChange();
              },
            }
          : null;
      snapshot = next;
    };
    const getSnapshot = () => {
      observe(
        !unavailable && clerk?.loaded && readBillingClerk() === clerk
          ? (clerk.user?.id ?? null)
          : null,
      );
      return snapshot;
    };
    return {
      getSnapshot,
      subscribe(notify: () => void) {
        notifyChange = notify;
        if (!clerk) return () => {};
        try {
          const stop = clerk.addListener((resources) => {
            // Consume departures even when React batches A -> B -> A into one render.
            observe(resources.user?.id ?? null);
            getSnapshot();
            notify();
          });
          if (typeof stop === "function")
            return () => {
              notifyChange = () => {};
              stop();
            };
        } catch {
          // An unobservable principal cannot own billing actions.
        }
        unavailable = true;
        getSnapshot();
        notify();
        return () => {};
      },
    };
  }, [clerk]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
}

/** A disposed or departed operation never becomes current again. */
export function createBillingAccountLifetime(
  account: BillingAccount | null,
  parentSignal?: AbortSignal,
): BillingAccountLifetime {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const depart = () => {
    abort();
    account?.invalidate();
  };
  const fence = createProjectReviewAccountFence(account?.userId ?? "", depart, () => {
    const current = readBillingClerk();
    return current === account?.clerk ? current : undefined;
  });
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) abort();

  const isCurrent = () => {
    if (controller.signal.aborted) return false;
    if (fence.isCurrent()) return true;
    abort();
    return false;
  };
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException("Billing account lifetime ended.", "AbortError");
  };
  return {
    signal: controller.signal,
    isCurrent,
    assertCurrent,
    wait(milliseconds) {
      if (!isCurrent()) return Promise.resolve(false);
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve(isCurrent());
        };
        const timer = setTimeout(finish, milliseconds);
        controller.signal.addEventListener("abort", finish, { once: true });
        if (controller.signal.aborted) finish();
      });
    },
    dispose() {
      abort();
      fence.dispose();
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

export function useBillingAccountLifetime(account: BillingAccount | null) {
  const [lifetime, setLifetime] = useState<BillingAccountLifetime | null>(null);
  useLayoutEffect(() => {
    const mountedLifetime = createBillingAccountLifetime(account);
    setLifetime(mountedLifetime);
    return () => mountedLifetime.dispose();
  }, [account]);
  return lifetime;
}

/** Guard both sides of token acquisition as well as response-body completion. */
export async function billingAccountRequest<T>(
  lifetime: BillingAccountLifetime | null,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  if (!lifetime) throw new DOMException("Billing account is not ready.", "AbortError");
  lifetime.assertCurrent();
  const response = await authFetch(
    url,
    { ...init, signal: lifetime.signal },
    lifetime.assertCurrent,
  );
  lifetime.assertCurrent();
  const data: unknown = response.status === 204 ? null : await response.json();
  lifetime.assertCurrent();
  if (!response.ok) {
    throw Object.assign(new Error("Billing request failed."), { data, status: response.status });
  }
  return data as T;
}
