import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ProjectImageItem } from "./project-image-model";
import { createProjectImageRequestScope } from "./project-image-request-scope";

type ImageScope = ReturnType<typeof createProjectImageRequestScope>;

interface ScopedImages {
  scope: ImageScope;
  images: ProjectImageItem[];
}

/** Keep live image collections and retained setters bound to one project visit. */
export function useProjectScopedImages(projectId: number) {
  const scope = useMemo(() => createProjectImageRequestScope(projectId), [projectId]);
  const [state, setState] = useState<ScopedImages>(() => ({ scope, images: [] }));

  useLayoutEffect(() => {
    scope.activate();
    return () => scope.deactivate();
  }, [scope]);

  const setImages = useCallback<Dispatch<SetStateAction<ProjectImageItem[]>>>(
    (update) => {
      const isCurrent = scope.capture();
      if (!isCurrent()) return;

      setState((current) => {
        if (!isCurrent()) return current;
        const previous = current.scope === scope ? current.images : [];
        const images = typeof update === "function" ? update(previous) : update;
        if (current.scope === scope && Object.is(images, current.images)) return current;
        return { scope, images };
      });
    },
    [scope],
  );

  return [state.scope === scope ? state.images : [], setImages] as const;
}
