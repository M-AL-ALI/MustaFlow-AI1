import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@workspace/tenant-runtime-contracts";
import {
  RuntimeMaterializationRpcScope,
  consumeRuntimeMaterializationRpcResult,
} from "../src/runtime-backend";
import {
  RUNTIME_MATERIALIZER_SOURCE,
  RUNTIME_MATERIALIZATION_PREPARER_SOURCE,
  RUNTIME_RELEASE_MAX_ARTIFACT_BYTES,
  RUNTIME_RELEASE_RETENTION_COUNT,
  RUNTIME_RELEASE_STALE_GRACE_MS,
  parseRuntimeMaterializationRequest,
  runtimeMaterializationPayloadPath,
  sealRuntimeMaterializationManifest,
  verifyRuntimeMaterializationRequest,
  type RuntimeMaterializationManifest,
} from "../src/runtime-materialization";

const execFileAsync = promisify(execFile);

interface MaterializerFixture {
  root: string;
  releaseBase: string;
  materializationBase: string;
  scriptPath: string;
  preparerSource: string;
}

function portablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function materializerFixture(): Promise<MaterializerFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "nabuflow-release-gc-"));
  const releaseBase = portablePath(path.join(root, "releases"));
  const materializationBase = portablePath(path.join(root, "materializations"));
  const scriptPath = portablePath(path.join(root, "materialize.mjs"));
  await mkdir(releaseBase, { recursive: true });
  await mkdir(materializationBase, { recursive: true });
  const source = RUNTIME_MATERIALIZER_SOURCE.replace(
    '"/workspace/.nabuflow/releases/"',
    JSON.stringify(`${releaseBase}/`),
  ).replace(
    "(stat.mode & 0o777) !== file.mode",
    'process.platform !== "win32" && (stat.mode & 0o777) !== file.mode',
  );
  await writeFile(scriptPath, source);
  const preparerSource = RUNTIME_MATERIALIZATION_PREPARER_SOURCE.replace(
    '"/workspace/.nabuflow/materializations/"',
    JSON.stringify(`${materializationBase}/`),
  ).replace('"/workspace/.nabuflow/releases"', JSON.stringify(releaseBase));
  return { root, releaseBase, materializationBase, scriptPath, preparerSource };
}

async function runMaterializer(
  fixture: MaterializerFixture,
  sealedArtifactSha256: string,
  options: {
    rollbackReleaseSha256?: string;
    abortAfterFiles?: number;
    abortReleaseCleanup?: boolean;
    abortBeforeReleaseSwap?: boolean;
    stageLeaseId?: string;
    holdLockMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const stageLeaseId = options.stageLeaseId ?? sealedArtifactSha256.slice(0, 32);
  await prepareMaterializerAttempt(fixture, sealedArtifactSha256, stageLeaseId, true);
  return executeMaterializer(fixture, sealedArtifactSha256, stageLeaseId, options);
}

async function prepareMaterializerAttempt(
  fixture: MaterializerFixture,
  sealedArtifactSha256: string,
  stageLeaseId: string,
  resetStage: boolean,
): Promise<void> {
  const contents = new TextEncoder().encode(`release:${sealedArtifactSha256}`);
  const contentSha256 = await sha256Hex(contents);
  const stageRoot = `${fixture.materializationBase}/${sealedArtifactSha256}`;
  if (resetStage) await rm(stageRoot, { recursive: true, force: true });
  await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    fixture.preparerSource,
    stageRoot,
    fixture.releaseBase,
    stageLeaseId,
  ]);
  const manifest = await sealRuntimeMaterializationManifest({
    format: "nabu-runtime-materialization/v1",
    sealedArtifactSha256,
    payloads: [{ index: 0, contentSha256, size: contents.byteLength }],
    files: [
      {
        path: "server.mjs",
        mode: 0o644,
        payloadIndex: 0,
        offset: 0,
        size: contents.byteLength,
        sha256: contentSha256,
      },
    ],
    seal: {
      contentSha256,
      sealedArtifactSha256,
      manifestRevision: `manifest-${sealedArtifactSha256.slice(0, 8)}`,
    },
  });
  const payload = {
    index: 0,
    contentSha256,
    size: contents.byteLength,
  };
  await writeFile(`${stageRoot}/manifest.json`, manifest.canonicalManifest);
  await writeFile(
    runtimeMaterializationPayloadPath(sealedArtifactSha256, payload).replace(
      "/workspace/.nabuflow/materializations",
      fixture.materializationBase,
    ),
    contents,
  );
}

async function executeMaterializer(
  fixture: MaterializerFixture,
  sealedArtifactSha256: string,
  stageLeaseId: string,
  options: {
    rollbackReleaseSha256?: string;
    abortAfterFiles?: number;
    abortReleaseCleanup?: boolean;
    abortBeforeReleaseSwap?: boolean;
    holdLockMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const stageRoot = `${fixture.materializationBase}/${sealedArtifactSha256}`;
  return execFileAsync(process.execPath, [
    fixture.scriptPath,
    `${stageRoot}/manifest.json`,
    stageRoot,
    `${fixture.releaseBase}/${sealedArtifactSha256}`,
    String(options.abortAfterFiles ?? 0),
    options.rollbackReleaseSha256 ?? "",
    options.abortReleaseCleanup === true ? "1" : "0",
    options.abortBeforeReleaseSwap === true ? "1" : "0",
    stageLeaseId,
    String(options.holdLockMs ?? 0),
  ]);
}

async function waitForPath(target: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${target}`);
}

async function managedReleaseNames(fixture: MaterializerFixture): Promise<string[]> {
  return (await readdir(fixture.releaseBase))
    .filter((name) => /^[0-9a-f]{64}(?:\.materializing)?$/u.test(name))
    .sort();
}

async function fixture(): Promise<RuntimeMaterializationManifest> {
  const first = new TextEncoder().encode("alpha");
  const second = new Uint8Array([0, 1, 2, 255]);
  return {
    format: "nabu-runtime-materialization/v1",
    sealedArtifactSha256: "a".repeat(64),
    payloads: [
      { index: 1, contentSha256: await sha256Hex(second), size: second.byteLength },
      { index: 0, contentSha256: await sha256Hex(first), size: first.byteLength },
    ],
    files: [
      {
        path: "node_modules/demo.bin",
        mode: 0o755,
        payloadIndex: 1,
        offset: 0,
        size: second.byteLength,
        sha256: await sha256Hex(second),
      },
      {
        path: "server.mjs",
        mode: 0o644,
        payloadIndex: 0,
        offset: 0,
        size: first.byteLength,
        sha256: await sha256Hex(first),
      },
    ],
    seal: {
      format: "nabu-artifact-layers/v1",
      contentSha256: "b".repeat(64),
      sealedArtifactSha256: "a".repeat(64),
      manifestRevision: "manifest-1",
      finalMergedReleaseSha256: "c".repeat(64),
      layers: ["d".repeat(64)],
    },
  };
}

describe("aggregate runtime materialization", () => {
  it("seals a deterministic canonical manifest independent of input order", async () => {
    const manifest = await fixture();
    const first = await sealRuntimeMaterializationManifest(manifest);
    const second = await sealRuntimeMaterializationManifest({
      ...manifest,
      payloads: [...manifest.payloads].reverse(),
      files: [...manifest.files].reverse(),
    });

    expect(second).toEqual(first);
    expect(parseRuntimeMaterializationRequest(first).files.map((file) => file.path)).toEqual([
      "node_modules/demo.bin",
      "server.mjs",
    ]);
    await expect(verifyRuntimeMaterializationRequest(first)).resolves.toMatchObject({
      sealedArtifactSha256: "a".repeat(64),
    });
  });

  it("fails closed on manifest tampering, traversal, noncontiguous payloads, and unknown fields", async () => {
    const request = await sealRuntimeMaterializationManifest(await fixture());
    await expect(
      verifyRuntimeMaterializationRequest({
        ...request,
        canonicalManifest: request.canonicalManifest.replace("server.mjs", "../server.mjs"),
      }),
    ).rejects.toThrow(/path|integrity/u);

    const manifest = await fixture();
    manifest.files[0].offset = 1;
    await expect(sealRuntimeMaterializationManifest(manifest)).rejects.toThrow(
      /contiguous|exceeds its payload/u,
    );

    const decoded = JSON.parse(request.canonicalManifest) as Record<string, unknown>;
    decoded.cellSuppliedProvenance = ["e".repeat(64)];
    await expect(
      verifyRuntimeMaterializationRequest({
        canonicalManifest: JSON.stringify(decoded),
        manifestSha256: await sha256Hex(JSON.stringify(decoded)),
      }),
    ).rejects.toThrow(/unsupported fields/u);
  });

  it("derives content-addressed payload paths without accepting unsafe hashes", async () => {
    const manifest = await fixture();
    const payload = manifest.payloads.find((candidate) => candidate.index === 0)!;
    expect(runtimeMaterializationPayloadPath(manifest.sealedArtifactSha256, payload)).toBe(
      `/workspace/.nabuflow/materializations/${"a".repeat(64)}/00-${payload.contentSha256}.payload`,
    );
    expect(() => runtimeMaterializationPayloadPath("../unsafe", payload)).toThrow(
      /sealed artifact hash/u,
    );
  });

  it("always disposes the RPC result and owning scope when materialization is canceled", async () => {
    const disposeResult = vi.fn();
    const disposeSandbox = vi.fn();
    const scope = new RuntimeMaterializationRpcScope();
    scope.track({ [Symbol.dispose]: disposeSandbox });

    await expect(
      consumeRuntimeMaterializationRpcResult(
        scope,
        Promise.resolve({ [Symbol.dispose]: disposeResult }),
        () => {
          throw new Error("forced mid-commit cancellation");
        },
      ),
    ).rejects.toThrow("forced mid-commit cancellation");
    scope.close();

    expect(disposeResult).toHaveBeenCalledTimes(1);
    expect(disposeSandbox).toHaveBeenCalledTimes(1);
  });

  it("keeps the in-cell enforcement point strict and atomic", () => {
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain("payloadStat.isFile()");
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain("post-unpack file hash mismatch");
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain("path escaped release root");
    expect(RUNTIME_MATERIALIZER_SOURCE).toContain(
      "await rename(temporaryReleaseRoot, releaseRoot)",
    );
    expect(RUNTIME_MATERIALIZER_SOURCE).not.toContain("symlink(");
  });

  it("bounds repeated distinct releases to the current and explicit rollback releases", async () => {
    const fixture = await materializerFixture();
    const releases = ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)];
    try {
      await runMaterializer(fixture, releases[0]);
      await runMaterializer(fixture, releases[1], { rollbackReleaseSha256: releases[0] });
      await runMaterializer(fixture, releases[1]);
      expect(await managedReleaseNames(fixture)).toEqual([releases[0], releases[1]]);
      await runMaterializer(fixture, releases[2], { rollbackReleaseSha256: releases[1] });
      const final = await runMaterializer(fixture, releases[3], {
        rollbackReleaseSha256: releases[2],
      });

      expect(JSON.parse(final.stdout)).toMatchObject({
        ok: true,
        releasesRetained: RUNTIME_RELEASE_RETENTION_COUNT,
        releasesRemoved: 1,
      });
      expect(await managedReleaseNames(fixture)).toEqual([releases[2], releases[3]]);
      expect(RUNTIME_RELEASE_RETENTION_COUNT * RUNTIME_RELEASE_MAX_ARTIFACT_BYTES).toBe(
        1024 * 1024 * 1024,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent same-SHA attempts without deleting a peer stage or release", async () => {
    const fixture = await materializerFixture();
    const release = "1".repeat(64);
    const firstLease = "a".repeat(32);
    const secondLease = "b".repeat(32);
    const lockRoot = `${fixture.releaseBase}/.runtime-materialization.lock`;
    try {
      await prepareMaterializerAttempt(fixture, release, firstLease, true);
      await prepareMaterializerAttempt(fixture, release, secondLease, false);

      const first = executeMaterializer(fixture, release, firstLease, { holdLockMs: 500 });
      await waitForPath(lockRoot);
      const second = executeMaterializer(fixture, release, secondLease);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(JSON.parse(firstResult.stdout)).toMatchObject({ ok: true, releasesRetained: 1 });
      expect(JSON.parse(secondResult.stdout)).toMatchObject({ ok: true, releasesRetained: 1 });
      expect(await managedReleaseNames(fixture)).toEqual([release]);
      await expect(
        readFile(`${fixture.releaseBase}/${release}/app/server.mjs`, "utf8"),
      ).resolves.toBe(`release:${release}`);
      await expect(access(`${fixture.materializationBase}/${release}`)).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent distinct SHAs and retains the actual prior filesystem release", async () => {
    const fixture = await materializerFixture();
    const original = "2".repeat(64);
    const first = "3".repeat(64);
    const second = "4".repeat(64);
    const firstLease = "c".repeat(32);
    const secondLease = "d".repeat(32);
    const lockRoot = `${fixture.releaseBase}/.runtime-materialization.lock`;
    try {
      await runMaterializer(fixture, original);
      await prepareMaterializerAttempt(fixture, first, firstLease, true);
      await prepareMaterializerAttempt(fixture, second, secondLease, true);

      const firstRun = executeMaterializer(fixture, first, firstLease, {
        rollbackReleaseSha256: original,
        holdLockMs: 500,
      });
      await waitForPath(lockRoot);
      const secondRun = executeMaterializer(fixture, second, secondLease, {
        // Both starts observed the same stored runtime. The filesystem state after the
        // first serialized swap is the authoritative rollback for the second.
        rollbackReleaseSha256: original,
      });
      await Promise.all([firstRun, secondRun]);

      expect(await managedReleaseNames(fixture)).toEqual([first, second]);
      await expect(
        readFile(`${fixture.releaseBase}/${first}/app/server.mjs`, "utf8"),
      ).resolves.toBe(`release:${first}`);
      await expect(
        readFile(`${fixture.releaseBase}/${second}/app/server.mjs`, "utf8"),
      ).resolves.toBe(`release:${second}`);
      await expect(
        readFile(`${fixture.releaseBase}/.release-state.json`, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        currentReleaseSha256: second,
        rollbackReleaseSha256: first,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("retains the current release and stale-safe rollback while removing old crash leftovers", async () => {
    const fixture = await materializerFixture();
    const current = "5".repeat(64);
    const next = "6".repeat(64);
    const staleRelease = `${"7".repeat(64)}.materializing`;
    const staleStage = "8".repeat(64);
    try {
      await runMaterializer(fixture, current);
      await mkdir(`${fixture.releaseBase}/${staleRelease}`, { recursive: true });
      await mkdir(`${fixture.materializationBase}/${staleStage}`, { recursive: true });
      const staleAt = new Date(Date.now() - RUNTIME_RELEASE_STALE_GRACE_MS - 60_000);
      await utimes(`${fixture.releaseBase}/${staleRelease}`, staleAt, staleAt);
      await utimes(`${fixture.materializationBase}/${staleStage}`, staleAt, staleAt);

      const result = await runMaterializer(fixture, next, {
        rollbackReleaseSha256: current,
      });

      expect(JSON.parse(result.stdout)).toMatchObject({
        releasesRetained: 2,
        leftoversRemoved: 3,
      });
      expect(await managedReleaseNames(fixture)).toEqual([current, next]);
      await expect(
        readFile(`${fixture.releaseBase}/.release-state.json`, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        currentReleaseSha256: next,
        rollbackReleaseSha256: current,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports cleanup failure after rename without deleting current or rollback", async () => {
    const fixture = await materializerFixture();
    const current = "9".repeat(64);
    const next = "a".repeat(64);
    try {
      await runMaterializer(fixture, current);
      await expect(
        runMaterializer(fixture, next, {
          rollbackReleaseSha256: current,
          abortReleaseCleanup: true,
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("release cleanup failed") });

      expect(await managedReleaseNames(fixture)).toEqual([current, next]);
      await expect(
        readFile(`${fixture.releaseBase}/.release-state.json`, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        currentReleaseSha256: current,
        rollbackReleaseSha256: null,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reuses a verified same-SHA release without an absent-current crash window", async () => {
    const fixture = await materializerFixture();
    const current = "f".repeat(64);
    try {
      await runMaterializer(fixture, current);
      const currentBytes = await readFile(`${fixture.releaseBase}/${current}/app/server.mjs`);

      await expect(
        runMaterializer(fixture, current, { abortBeforeReleaseSwap: true }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("release swap interrupted") });

      await expect(readFile(`${fixture.releaseBase}/${current}/app/server.mjs`)).resolves.toEqual(
        currentBytes,
      );
      expect(await managedReleaseNames(fixture)).toEqual([current]);
      await expect(
        readFile(`${fixture.releaseBase}/.release-state.json`, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        currentReleaseSha256: current,
        rollbackReleaseSha256: null,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("replaces a corrupt same-SHA final release from the independently verified temp", async () => {
    const fixture = await materializerFixture();
    const current = "0".repeat(64);
    try {
      await runMaterializer(fixture, current);
      await writeFile(`${fixture.releaseBase}/${current}/seal.json`, '{"corrupt":true}');

      const repaired = await runMaterializer(fixture, current);

      expect(JSON.parse(repaired.stdout)).toMatchObject({ ok: true, releasesRetained: 1 });
      await expect(
        readFile(`${fixture.releaseBase}/${current}/app/server.mjs`, "utf8"),
      ).resolves.toBe(`release:${current}`);
      await expect(
        readFile(`${fixture.releaseBase}/${current}/seal.json`, "utf8").then(JSON.parse),
      ).resolves.toMatchObject({ sealedArtifactSha256: current });
      expect((await readdir(fixture.releaseBase)).some((name) => name.includes(".corrupt-"))).toBe(
        false,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("performs no release or leftover cleanup before the atomic rename succeeds", async () => {
    const fixture = await materializerFixture();
    const current = "b".repeat(64);
    const staleComplete = "c".repeat(64);
    const staleMaterializing = `${"d".repeat(64)}.materializing`;
    const failed = "e".repeat(64);
    try {
      await runMaterializer(fixture, current);
      await mkdir(`${fixture.releaseBase}/${staleComplete}`, { recursive: true });
      await mkdir(`${fixture.releaseBase}/${staleMaterializing}`, { recursive: true });
      const staleAt = new Date(Date.now() - RUNTIME_RELEASE_STALE_GRACE_MS - 60_000);
      await utimes(`${fixture.releaseBase}/${staleMaterializing}`, staleAt, staleAt);

      await expect(
        runMaterializer(fixture, failed, {
          rollbackReleaseSha256: current,
          abortAfterFiles: 1,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("staging materializer owner-loss probe"),
      });

      expect(await managedReleaseNames(fixture)).toEqual([
        current,
        staleComplete,
        staleMaterializing,
      ]);
      await expect(
        readFile(`${fixture.releaseBase}/.release-state.json`, "utf8").then(JSON.parse),
      ).resolves.toEqual({
        currentReleaseSha256: current,
        rollbackReleaseSha256: null,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
