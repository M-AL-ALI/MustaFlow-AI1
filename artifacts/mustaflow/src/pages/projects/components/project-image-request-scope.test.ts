import { describe, expect, it } from "vitest";
import { createProjectImageRequestScope } from "./project-image-request-scope";

describe("project image request isolation", () => {
  it("does not authorize requests before mount or after unmount", () => {
    const scope = createProjectImageRequestScope(1);
    const beforeMount = scope.capture();
    expect(beforeMount()).toBe(false);
    expect(scope.claim("generate")).toBeNull();
    scope.activate();
    expect(beforeMount()).toBe(false);
    const mounted = scope.capture();
    expect(mounted()).toBe(true);
    scope.deactivate();
    expect(mounted()).toBe(false);
    expect(scope.claim("generate")).toBeNull();
  });

  it("keeps equal numeric project IDs in separate mounted scopes", () => {
    const first = createProjectImageRequestScope(7);
    const second = createProjectImageRequestScope(7);
    first.activate();
    second.activate();
    const firstRequest = first.capture();
    const secondRequest = second.capture();
    first.deactivate();
    expect(firstRequest()).toBe(false);
    expect(secondRequest()).toBe(true);
  });

  it("does not revive an A request after switching A to B to A", () => {
    const a = createProjectImageRequestScope(1);
    const b = createProjectImageRequestScope(2);
    a.activate();
    const originalA = a.capture();
    a.deactivate();
    b.activate();
    const originalB = b.capture();
    b.deactivate();
    a.activate();
    expect(originalA()).toBe(false);
    expect(originalB()).toBe(false);
    expect(a.capture()()).toBe(true);
  });

  it("invalidates Strict Mode setup requests during cleanup and replay", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const firstSetup = scope.capture();
    scope.deactivate();
    scope.activate();
    expect(firstSetup()).toBe(false);
    expect(scope.capture()()).toBe(true);
  });

  it("accepts only the latest list response", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const first = scope.capture("list");
    const second = scope.capture("list");
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("does not let polling invalidate independent image work", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const insertion = scope.capture();
    const history = scope.capture("history");
    scope.capture("list");
    scope.capture("list");
    expect(insertion()).toBe(true);
    expect(history()).toBe(true);
  });

  it("locks generation synchronously against duplicate clicks", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const first = scope.claim("generate");
    expect(first?.isCurrent()).toBe(true);
    expect(scope.claim("generate")).toBeNull();
    first?.release();
    expect(first?.isCurrent()).toBe(false);
    expect(scope.claim("generate")?.isCurrent()).toBe(true);
  });

  it("does not let an abandoned generation release a newer generation lock", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const previous = scope.claim("generate");
    scope.deactivate();
    scope.activate();
    const current = scope.claim("generate");
    previous?.release();
    expect(previous?.isCurrent()).toBe(false);
    expect(current?.isCurrent()).toBe(true);
    expect(scope.claim("generate")).toBeNull();
  });

  it("does not let a repeated release clear another operation in the same generation", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const first = scope.claim("generate");
    first?.release();
    const second = scope.claim("generate");
    first?.release();
    expect(second?.isCurrent()).toBe(true);
    expect(scope.claim("generate")).toBeNull();
  });

  it("keeps independent exclusive operation channels separate", () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const generation = scope.claim("generate");
    const insertion = scope.claim("insert");
    expect(generation?.isCurrent()).toBe(true);
    expect(insertion?.isCurrent()).toBe(true);
    generation?.release();
    expect(insertion?.isCurrent()).toBe(true);
  });

  it("discards a late fulfilled operation after project departure", async () => {
    const scope = createProjectImageRequestScope(1);
    scope.activate();
    const isCurrent = scope.capture();
    let complete!: (value: string) => void;
    const result = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const visible: string[] = [];
    const operation = result.then((value) => {
      if (isCurrent()) visible.push(value);
    });
    scope.deactivate();
    complete("old-project-image");
    await operation;
    expect(visible).toEqual([]);
  });
});
