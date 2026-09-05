import { act, cleanup, renderHook } from "@testing-library/react";
import { startTransition, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectImageItem } from "./project-image-model";
import { useProjectScopedImages } from "./use-project-scoped-images";

const PROJECT_A = 101;
const PROJECT_B = 202;

function image(id: number): ProjectImageItem {
  return {
    key: "studio:" + id,
    source: "studio",
    id,
    prompt: "Scoped image " + id,
    status: "completed",
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

function renderImages(projectId = PROJECT_A) {
  return renderHook((props: { projectId: number }) => useProjectScopedImages(props.projectId), {
    initialProps: { projectId },
  });
}

afterEach(() => {
  cleanup();
});

describe("useProjectScopedImages", () => {
  it("preserves array assignment, functional updates, and unchanged-array identity", () => {
    const hook = renderImages();
    const first = image(1011);
    const second = image(1012);
    const initial = [first];

    act(() => {
      hook.result.current[1](initial);
    });
    expect(hook.result.current[0]).toBe(initial);

    const append = vi.fn((previous: ProjectImageItem[]) => [...previous, second]);
    act(() => {
      hook.result.current[1](append);
    });
    expect(append).toHaveBeenCalledWith(initial);
    expect(hook.result.current[0]).toEqual([first, second]);

    const unchanged = hook.result.current[0];
    act(() => {
      hook.result.current[1]((previous) => previous);
    });
    expect(hook.result.current[0]).toBe(unchanged);
  });

  it("masks A images at B's first layout commit and starts B updates from an empty collection", () => {
    const commits: { projectId: number; images: ProjectImageItem[] }[] = [];
    const hook = renderHook(
      (props: { projectId: number }) => {
        const result = useProjectScopedImages(props.projectId);
        useLayoutEffect(() => {
          commits.push({ projectId: props.projectId, images: result[0] });
        });
        return result;
      },
      { initialProps: { projectId: PROJECT_A } },
    );
    const a = image(1013);
    const b = image(2021);
    act(() => {
      hook.result.current[1]([a]);
    });
    hook.rerender({ projectId: PROJECT_B });

    const bCommits = commits.filter((commit) => commit.projectId === PROJECT_B);
    expect(bCommits.length).toBeGreaterThan(0);
    for (const commit of bCommits) expect(commit.images).toEqual([]);
    expect(hook.result.current[0]).toEqual([]);

    const appendB = vi.fn((previous: ProjectImageItem[]) => [...previous, b]);
    act(() => {
      hook.result.current[1](appendB);
    });
    expect(appendB).toHaveBeenCalledWith([]);
    expect(hook.result.current[0]).toEqual([b]);
  });

  it("drops retained A setters without evaluating stale functions or overwriting current B", () => {
    const hook = renderImages();
    const setA = hook.result.current[1];
    const a = image(1014);
    const b = image(2022);
    const nextB = image(2023);
    hook.rerender({ projectId: PROJECT_B });
    act(() => {
      hook.result.current[1]([b]);
    });

    const staleUpdate = vi.fn((previous: ProjectImageItem[]) => [...previous, a]);
    act(() => {
      setA([a]);
      setA(staleUpdate);
    });
    expect(staleUpdate).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toEqual([b]);

    const appendB = vi.fn((previous: ProjectImageItem[]) => [...previous, nextB]);
    act(() => {
      hook.result.current[1](appendB);
    });
    expect(appendB).toHaveBeenCalledWith([b]);
    expect(hook.result.current[0]).toEqual([b, nextB]);
  });

  it("creates a new scope for A after A to B to A and never revives either retained setter", () => {
    const hook = renderImages();
    const oldSetA = hook.result.current[1];
    const oldA = image(1015);
    act(() => {
      oldSetA([oldA]);
    });
    hook.rerender({ projectId: PROJECT_B });
    const oldSetB = hook.result.current[1];
    const oldB = image(2024);
    act(() => {
      oldSetB([oldB]);
    });
    hook.rerender({ projectId: PROJECT_A });
    const newSetA = hook.result.current[1];
    expect(newSetA).not.toBe(oldSetA);
    expect(hook.result.current[0]).toEqual([]);

    const staleAUpdate = vi.fn(() => [oldA]);
    const staleBUpdate = vi.fn(() => [oldB]);
    act(() => {
      oldSetA(staleAUpdate);
      oldSetB(staleBUpdate);
    });
    expect(staleAUpdate).not.toHaveBeenCalled();
    expect(staleBUpdate).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toEqual([]);

    const newA = image(1016);
    act(() => {
      newSetA((previous) => [...previous, newA]);
      oldSetA([oldA]);
      oldSetB([oldB]);
    });
    expect(hook.result.current[0]).toEqual([newA]);
  });

  it("rejects writes before a new scope's layout activation without evaluating the updater", () => {
    const attemptedProjects = new Set<number>();
    const beforeLayout = vi.fn((previous: ProjectImageItem[]) => [...previous, image(1017)]);
    const hook = renderHook(
      (props: { projectId: number }) => {
        const result = useProjectScopedImages(props.projectId);
        if (!attemptedProjects.has(props.projectId)) {
          attemptedProjects.add(props.projectId);
          result[1]([image(props.projectId)]);
          result[1](beforeLayout);
        }
        return result;
      },
      { initialProps: { projectId: PROJECT_A } },
    );
    expect(beforeLayout).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toEqual([]);

    hook.rerender({ projectId: PROJECT_B });
    expect(beforeLayout).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toEqual([]);
    const b = image(2025);
    act(() => {
      hook.result.current[1]([b]);
    });
    expect(hook.result.current[0]).toEqual([b]);
  });

  it("drops an A updater queued before B's layout invalidates its captured scope", () => {
    const hook = renderImages();
    const setA = hook.result.current[1];
    const staleUpdate = vi.fn((previous: ProjectImageItem[]) => [...previous, image(1018)]);

    act(() => {
      startTransition(() => {
        // Occupy the transition lane so the following updater is not eagerly evaluated.
        setA((previous) => [...previous]);
        setA(staleUpdate);
      });
      flushSync(() => {
        hook.rerender({ projectId: PROJECT_B });
      });
    });

    expect(staleUpdate).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toEqual([]);
    const b = image(2026);
    const nextB = image(2027);
    act(() => {
      hook.result.current[1]([b]);
      hook.result.current[1]((previous) => [...previous, nextB]);
      setA([image(1019)]);
    });
    expect(hook.result.current[0]).toEqual([b, nextB]);
  });

  it("does not resurrect queued first-visit A updates after synchronous A to B to A navigation", () => {
    const hook = renderImages();
    const oldSetA = hook.result.current[1];
    const staleUpdate = vi.fn(() => [image(1020)]);

    act(() => {
      startTransition(() => {
        oldSetA((previous) => [...previous]);
        oldSetA(staleUpdate);
      });
      flushSync(() => {
        hook.rerender({ projectId: PROJECT_B });
      });
      flushSync(() => {
        hook.rerender({ projectId: PROJECT_A });
      });
    });

    expect(staleUpdate).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toEqual([]);
    const newA = image(1021);
    act(() => {
      hook.result.current[1]((previous) => [...previous, newA]);
      oldSetA([image(1022)]);
    });
    expect(hook.result.current[0]).toEqual([newA]);
  });

  it("drops queued and retained writes after unmount without evaluating their functions", () => {
    const hook = renderImages();
    const retainedSet = hook.result.current[1];
    const queuedUpdate = vi.fn(() => [image(1023)]);

    act(() => {
      startTransition(() => {
        retainedSet((previous) => [...previous]);
        retainedSet(queuedUpdate);
      });
      hook.unmount();
    });

    expect(queuedUpdate).not.toHaveBeenCalled();
    const afterUnmount = vi.fn(() => [image(1024)]);
    act(() => {
      retainedSet([image(1025)]);
      retainedSet(afterUnmount);
    });
    expect(afterUnmount).not.toHaveBeenCalled();
  });

  it("keeps a retained setter valid across ordinary same-project rerenders", () => {
    const hook = renderImages();
    const retainedSet = hook.result.current[1];
    const first = image(1026);
    act(() => {
      retainedSet([first]);
    });
    hook.rerender({ projectId: PROJECT_A });
    expect(hook.result.current[1]).toBe(retainedSet);
    const second = image(1027);
    act(() => {
      retainedSet((previous) => [...previous, second]);
    });
    expect(hook.result.current[0]).toEqual([first, second]);
  });
});
