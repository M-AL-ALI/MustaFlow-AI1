import { lazy, type LazyExoticComponent } from "react";
import { retryBuilderChunkImport } from "./builder-chunk-recovery";

// Match React.lazy's component constraint while preserving each component's props.
type LazyComponent = Awaited<ReturnType<Parameters<typeof lazy>[0]>>["default"];
type LazyModule<T extends LazyComponent> = {
  default: T;
};

/** Existing default-export importers keep the same API and inferred component. */
export function builderLazy<T extends LazyComponent>(
  importer: () => Promise<LazyModule<T>>,
): LazyExoticComponent<T>;
export function builderLazy<Module, T extends LazyComponent>(
  importer: () => Promise<Module>,
  select: (module: Module) => T,
): LazyExoticComponent<T>;

/** Recover the raw module first; select its component on either success path. */
export function builderLazy<Module, T extends LazyComponent>(
  importer: () => Promise<Module>,
  select?: (module: Module) => T,
): LazyExoticComponent<T> {
  return lazy(async () => {
    const module = await retryBuilderChunkImport(importer);
    // A selector failure is a component-mapping error, not another chunk load.
    return select ? { default: select(module) } : (module as LazyModule<T>);
  });
}
