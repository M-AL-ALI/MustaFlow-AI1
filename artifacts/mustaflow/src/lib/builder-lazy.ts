import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { retryBuilderChunkImport } from "./builder-chunk-recovery";

type LazyModule<T extends ComponentType<unknown>> = {
  default: T;
};

/** React.lazy with one cache-busted retry before the guarded reload layer. */
export function builderLazy<T extends ComponentType<unknown>>(
  importer: () => Promise<LazyModule<T>>,
): LazyExoticComponent<T> {
  return lazy(() => retryBuilderChunkImport(importer));
}
