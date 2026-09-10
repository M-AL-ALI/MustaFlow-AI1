import type { BrowserClerk } from "@clerk/react";

type PrincipalUser = Pick<NonNullable<BrowserClerk["user"]>, "id">;

// The subset of the installed Clerk interface needed at synchronous boundaries.
export type ProjectReviewClerk = {
  loaded: boolean;
  user: PrincipalUser | null | undefined;
  addListener: (listener: (resources: { user?: PrincipalUser | null }) => void) => () => void;
};

export type ProjectReviewAccountFence = {
  isCurrent: () => boolean;
  dispose: () => void;
};

function currentBrowserClerk(): ProjectReviewClerk | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Clerk?: ProjectReviewClerk }).Clerk;
}

// Any observed principal departure permanently invalidates this form's fence.
// Reading the SDK snapshot also covers callbacks before our listener is delivered.
export function createProjectReviewAccountFence(
  ownerId: string,
  onInvalidate: () => void = () => {},
  readClerk: () => ProjectReviewClerk | undefined = currentBrowserClerk,
): ProjectReviewAccountFence {
  let clerk: ProjectReviewClerk | undefined;
  let valid = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  try {
    clerk = readClerk();
    valid = Boolean(ownerId && clerk?.loaded && clerk.user?.id === ownerId);
  } catch {
    // An unavailable principal cannot authorize effects.
  }

  function invalidate() {
    if (!valid || disposed) return;
    valid = false;
    onInvalidate();
  }

  function isCurrent(): boolean {
    if (!valid || disposed) return false;
    try {
      if (readClerk() !== clerk || !clerk?.loaded || clerk.user?.id !== ownerId) {
        invalidate();
      }
    } catch {
      invalidate();
    }
    return valid && !disposed;
  }

  if (valid && clerk) {
    try {
      unsubscribe = clerk.addListener((resources) => {
        if (disposed) return;
        if (resources.user?.id !== ownerId) invalidate();
        else isCurrent();
      });
      if (typeof unsubscribe !== "function") invalidate();
      // Registration can synchronously emit or race with a resource update.
      isCurrent();
    } catch {
      invalidate();
    }
  }

  return {
    isCurrent,
    dispose() {
      if (disposed) return;
      disposed = true;
      valid = false;
      const stop = unsubscribe;
      unsubscribe = undefined;
      try {
        stop?.();
      } catch {
        // Even a failed unsubscribe leaves this fence and its callback inert.
      }
    },
  };
}
