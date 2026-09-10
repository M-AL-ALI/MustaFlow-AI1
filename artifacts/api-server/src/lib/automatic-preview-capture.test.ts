import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("./tenant-runtime", () => ({ tenantRuntimeProvider: {} }));

import {
  automaticPreviewKey,
  createAutomaticPreviewRunner,
  decodeAutomaticPreview,
  AUTOMATIC_PREVIEW_MAX_BYTES,
  AutomaticPreviewError,
  type AutomaticPreviewAttempt,
  type AutomaticPreviewDependencies,
} from "./automatic-preview-capture";
import type { PreviewVersionWitness } from "./preview-version-provenance";

const target = { projectId: 81, versionId: 100 };
const witness: PreviewVersionWitness = {
  ...target,
  sourceSha256: "a".repeat(64),
  runtimeIdentity: "runtime-81",
  manifestRevision: "manifest-1",
  sealedArtifactSha256: "b".repeat(64),
};

// Synthetic PNG header for byte/identity boundary unit tests, not a rendering receipt.
function providerResponse() {
  const png = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  return {
    ok: true,
    capture: {
      mimeType: "image/png",
      base64: png.toString("base64"),
      sha256: createHash("sha256").update(png).digest("hex"),
      width: 1280,
      height: 800,
      route: "/",
      runtimeIdentity: witness.runtimeIdentity,
      manifestRevision: witness.manifestRevision,
      sealedArtifactSha256: witness.sealedArtifactSha256,
    },
  };
}

function setup() {
  let held = false;
  const active = vi.fn(async () => true);
  const release = vi.fn();
  const untrack = vi.fn();
  const project = { id: 81, ownerId: "owner" };
  const deps = {
    async withProject<T>(
      _id: number,
      work: (session: { assertActive(): Promise<boolean> }) => Promise<T>,
    ) {
      held = true;
      try {
        return {
          state: "active" as const,
          value: await work({ assertActive: active }),
        };
      } finally {
        held = false;
        release();
      }
    },
    loadProject: vi.fn(async () => project),
    admit: vi.fn(async () => {
      expect(held).toBe(true);
      return true;
    }),
    readWitness: vi.fn(async (): Promise<PreviewVersionWitness | null> => ({ ...witness })),
    readAttempts: vi.fn(async (): Promise<AutomaticPreviewAttempt[]> => []),
    reserve: vi.fn(async () => {
      expect(held).toBe(true);
      return { id: 700, storageKey: "private/700.png" };
    }),
    begin: vi.fn(async () => true),
    capture: vi.fn(async () => {
      expect(held).toBe(true);
      return providerResponse();
    }),
    upload: vi.fn(async () => {
      expect(held).toBe(true);
    }),
    complete: vi.fn(async () => {
      expect(held).toBe(true);
    }),
    cleanup: vi.fn(async () => {
      expect(held).toBe(true);
    }),
    track: vi.fn((_id: number, _controller: AbortController) => untrack),
  } satisfies AutomaticPreviewDependencies;
  return {
    deps,
    active,
    release,
    untrack,
    run: createAutomaticPreviewRunner(deps),
  };
}

function attempt(
  state: string,
  options: Partial<AutomaticPreviewAttempt> = {},
): AutomaticPreviewAttempt {
  return {
    id: 600,
    storageKey: "private/600.png",
    state,
    createdAt: new Date(0),
    needsCleanup: false,
    ...options,
  };
}

describe("automatic private preview coordinator", () => {
  it("holds the lifecycle session through admission, capture, storage and receipt", async () => {
    const s = setup();
    expect(await s.run(target)).toEqual({ state: "ready", assetId: 700 });
    expect(s.deps.admit).toHaveBeenCalledWith(target);
    expect(s.deps.readWitness).toHaveBeenCalledTimes(2);
    expect(s.deps.complete).toHaveBeenCalledTimes(1);
    expect(s.deps.cleanup).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.untrack).toHaveBeenCalledTimes(1);
  });

  it("uses durable ready assets after the queue's dedupe row has expired", async () => {
    const s = setup();
    s.deps.readAttempts.mockResolvedValue([attempt("ready")]);
    expect(await s.run(target)).toEqual({ state: "existing", assetId: 600 });
    expect(s.deps.admit).not.toHaveBeenCalled();
    expect(s.deps.reserve).not.toHaveBeenCalled();
    expect(s.deps.capture).not.toHaveBeenCalled();
  });

  it.each(["deleted", "deleting"])(
    "does not recreate an intentionally %s preview",
    async (state) => {
      const s = setup();
      s.deps.readAttempts.mockResolvedValue([attempt(state)]);
      expect(await s.run(target)).toEqual({
        state: "skipped",
        reason: "removed",
      });
      expect(s.deps.capture).not.toHaveBeenCalled();
    },
  );

  it("limits billed renderer attempts using persisted asset receipts", async () => {
    const s = setup();
    s.deps.readAttempts.mockResolvedValue([
      attempt("rejected", { id: 600 }),
      attempt("rejected", { id: 601 }),
      attempt("rejected", { id: 602 }),
    ]);
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "attempt-limit",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
  });

  it("finishes outstanding cleanup even after the attempt budget is exhausted", async () => {
    const s = setup();
    const clean = [
      attempt("rejected", { id: 600 }),
      attempt("rejected", { id: 601 }),
      attempt("rejected", { id: 602 }),
    ];
    s.deps.readAttempts
      .mockResolvedValueOnce([{ ...clean[0]!, needsCleanup: true }, ...clean.slice(1)])
      .mockResolvedValue(clean);
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "attempt-limit",
    });
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1_000_000, NaN])(
    "does not turn an uncertain PUT into a new capture based on timestamp %s",
    async (timestamp) => {
      const s = setup();
      s.deps.readAttempts.mockResolvedValue([
        attempt("uploading", { createdAt: new Date(timestamp) }),
      ]);
      s.deps.cleanup.mockRejectedValue(
        new AutomaticPreviewError("automatic_preview_put_uncertain"),
      );
      await expect(s.run(target)).rejects.toMatchObject({
        code: "automatic_preview_put_uncertain",
      });
      await expect(s.run(target)).rejects.toMatchObject({
        code: "automatic_preview_put_uncertain",
      });
      expect(s.deps.cleanup).toHaveBeenCalledTimes(2);
      expect(s.deps.admit).not.toHaveBeenCalled();
      expect(s.deps.reserve).not.toHaveBeenCalled();
      expect(s.deps.capture).not.toHaveBeenCalled();
    },
  );

  it.each(["reserved", "uploading"])(
    "lets storage prove a recent %s attempt safe without an age heuristic",
    async (state) => {
      const s = setup();
      s.deps.readAttempts
        .mockResolvedValueOnce([attempt(state, { createdAt: new Date() })])
        .mockResolvedValue([attempt("rejected")]);
      expect(await s.run(target)).toEqual({ state: "ready", assetId: 700 });
      expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
      expect(s.deps.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        s.deps.reserve.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("refreshes a recovered ready COMMIT before deciding whether to reserve again", async () => {
    const s = setup();
    s.deps.readAttempts
      .mockResolvedValueOnce([attempt("uploading")])
      .mockResolvedValue([attempt("ready")]);
    expect(await s.run(target)).toEqual({ state: "existing", assetId: 600 });
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
    expect(s.deps.readAttempts).toHaveBeenCalledTimes(2);
    expect(s.deps.admit).not.toHaveBeenCalled();
    expect(s.deps.reserve).not.toHaveBeenCalled();
    expect(s.deps.capture).not.toHaveBeenCalled();
  });

  it("refreshes tombstones after cleanup instead of recreating a removed preview", async () => {
    const s = setup();
    s.deps.readAttempts
      .mockResolvedValueOnce([attempt("uploading")])
      .mockResolvedValue([attempt("deleted")]);
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "removed",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
  });

  it("refreshes the durable attempt budget after cleanup", async () => {
    const s = setup();
    s.deps.readAttempts
      .mockResolvedValueOnce([attempt("uploading")])
      .mockResolvedValue([
        attempt("rejected", { id: 600 }),
        attempt("rejected", { id: 601 }),
        attempt("rejected", { id: 602 }),
      ]);
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "attempt-limit",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
  });

  it("does not trust a cleanup return while the refreshed row still needs recovery", async () => {
    const s = setup();
    s.deps.readAttempts.mockResolvedValue([attempt("uploading")]);
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_cleanup_pending",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
  });

  it("cleans old attempts before checking current capture admission", async () => {
    const s = setup();
    s.deps.readAttempts
      .mockResolvedValueOnce([attempt("uploading")])
      .mockResolvedValue([attempt("rejected")]);
    s.deps.admit.mockResolvedValue(false);
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "disabled",
    });
    expect(s.deps.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      s.deps.admit.mock.invocationCallOrder[0]!,
    );
    expect(s.deps.readWitness).not.toHaveBeenCalled();
    expect(s.deps.reserve).not.toHaveBeenCalled();
    expect(s.deps.capture).not.toHaveBeenCalled();
  });

  it("runs cleanup-only recovery without admission or a running runtime", async () => {
    const s = setup();
    s.deps.readAttempts
      .mockResolvedValueOnce([attempt("uploading")])
      .mockResolvedValue([attempt("rejected")]);
    s.deps.admit.mockResolvedValue(false);
    s.deps.readWitness.mockResolvedValue(null);
    expect(await s.run({ ...target, cleanupOnly: true })).toEqual({
      state: "skipped",
      reason: "cleanup-only",
    });
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
    expect(s.deps.admit).not.toHaveBeenCalled();
    expect(s.deps.readWitness).not.toHaveBeenCalled();
    expect(s.deps.reserve).not.toHaveBeenCalled();
    expect(s.deps.capture).not.toHaveBeenCalled();
  });

  it("reports uncertainty even during disabled cleanup-only recovery", async () => {
    const s = setup();
    s.deps.admit.mockResolvedValue(false);
    s.deps.readAttempts.mockResolvedValue([attempt("uploading")]);
    s.deps.cleanup.mockRejectedValue(new AutomaticPreviewError("automatic_preview_put_uncertain"));
    await expect(s.run({ ...target, cleanupOnly: true })).rejects.toMatchObject({
      code: "automatic_preview_put_uncertain",
    });
    expect(s.deps.admit).not.toHaveBeenCalled();
    expect(s.deps.capture).not.toHaveBeenCalled();
  });

  it("does not start or reserve when the accepted runtime cannot be witnessed", async () => {
    const s = setup();
    s.deps.readWitness.mockResolvedValue(null);
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "not-ready",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
    expect(s.deps.capture).not.toHaveBeenCalled();
  });

  it("does not capture an older queued version after a new build replaces it", async () => {
    const s = setup();
    s.deps.readWitness.mockResolvedValue({ ...witness, versionId: 101 });
    expect(await s.run(target)).toEqual({
      state: "skipped",
      reason: "superseded",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
  });

  it("rejects an artifact change during rendering before uploading anything", async () => {
    const s = setup();
    s.deps.readWitness
      .mockResolvedValueOnce(witness)
      .mockResolvedValueOnce({ ...witness, manifestRevision: "changed" });
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_version_changed",
    });
    expect(s.deps.upload).not.toHaveBeenCalled();
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it("aborts before upload if Trash cancels the capture", async () => {
    const s = setup();
    s.deps.capture.mockImplementation(async () => {
      s.deps.track.mock.calls[0]![1].abort();
      return providerResponse();
    });
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_project_inactive",
    });
    expect(s.deps.upload).not.toHaveBeenCalled();
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not publish after the lifecycle witness is lost", async () => {
    const s = setup();
    s.active.mockResolvedValue(false);
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_project_inactive",
    });
    expect(s.deps.reserve).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation again after the held-connection query resolves", async () => {
    const s = setup();
    s.active.mockImplementationOnce(async () => {
      s.deps.track.mock.calls[0]![1].abort();
      return true;
    });
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_project_inactive",
    });
    expect(s.deps.readAttempts).not.toHaveBeenCalled();
    expect(s.deps.reserve).not.toHaveBeenCalled();
  });

  it("leaves a durable cleanup retry when the provider cannot prove absence", async () => {
    const s = setup();
    s.deps.capture.mockRejectedValue(new Error("secret provider detail"));
    s.deps.cleanup.mockRejectedValue(new Error("storage offline"));
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_cleanup_pending",
    });
    expect(s.deps.complete).not.toHaveBeenCalled();
  });

  it("preserves the explicit uncertain PUT error after a failed upload", async () => {
    const s = setup();
    s.deps.upload.mockRejectedValue(new Error("PUT response timed out"));
    s.deps.cleanup.mockRejectedValue(new AutomaticPreviewError("automatic_preview_put_uncertain"));
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_put_uncertain",
    });
    expect(s.deps.reserve).toHaveBeenCalledTimes(1);
    expect(s.deps.complete).not.toHaveBeenCalled();
  });

  it("never substitutes a provider error message for a safe job failure code", async () => {
    const s = setup();
    s.deps.capture.mockRejectedValue(new Error("secret provider detail"));
    await expect(s.run(target)).rejects.toThrow("automatic_preview_capture_failed");
  });

  it("retains the lock while settling an ambiguous final commit", async () => {
    const s = setup();
    s.deps.complete.mockRejectedValue(new Error("response lost after commit"));
    await expect(s.run(target)).rejects.toMatchObject({
      code: "automatic_preview_capture_failed",
    });
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
    expect(s.release.mock.invocationCallOrder[0]).toBeGreaterThan(
      s.deps.cleanup.mock.invocationCallOrder[0]!,
    );
  });

  it("returns a durable ready receipt after the final COMMIT response is lost", async () => {
    const s = setup();
    s.deps.complete.mockRejectedValue(new Error("response lost after commit"));
    s.deps.readAttempts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([attempt("ready", { id: 700 })]);
    expect(await s.run(target)).toEqual({ state: "existing", assetId: 700 });
    expect(s.deps.cleanup).toHaveBeenCalledTimes(1);
    expect(s.deps.reserve).toHaveBeenCalledTimes(1);
    expect(s.deps.capture).toHaveBeenCalledTimes(1);
    expect(s.release.mock.invocationCallOrder[0]).toBeGreaterThan(
      s.deps.readAttempts.mock.invocationCallOrder[2]!,
    );
  });

  it.each([0, -1, 1.2, NaN, Infinity, 2147483648])(
    "rejects hostile target id %s",
    async (projectId) => {
      const s = setup();
      await expect(s.run({ projectId, versionId: 100 })).rejects.toMatchObject({
        code: "automatic_preview_invalid_target",
      });
      expect(s.deps.loadProject).not.toHaveBeenCalled();
    },
  );
});

describe("automatic preview response boundary", () => {
  it("has a canonical project/version/route/viewport key shared by recovery", () => {
    expect(automaticPreviewKey(target)).toBe(automaticPreviewKey({ ...target, cleanupOnly: true }));
    expect(automaticPreviewKey(target)).not.toBe(automaticPreviewKey({ ...target, projectId: 82 }));
    expect(automaticPreviewKey(target)).not.toBe(
      automaticPreviewKey({ ...target, versionId: 101 }),
    );
  });

  it("accepts matching bounded PNG bytes", () => {
    expect(decodeAutomaticPreview(providerResponse(), witness)).toHaveLength(33);
  });

  it.each([
    ["runtimeIdentity", "other"],
    ["manifestRevision", "other"],
    ["sealedArtifactSha256", "c".repeat(64)],
    ["route", "/private"],
    ["width", 1920],
    ["height", 900],
    ["mimeType", "text/html"],
    ["sha256", "c".repeat(64)],
    ["base64", "not-png"],
  ])("rejects mismatched %s", (field, value) => {
    const response = providerResponse();
    expect(() =>
      decodeAutomaticPreview(
        { ...response, capture: { ...response.capture, [field]: value } },
        witness,
      ),
    ).toThrow();
  });

  it("rejects oversized bytes before decoding", () => {
    const response = providerResponse();
    response.capture.base64 = "A".repeat(Math.ceil(AUTOMATIC_PREVIEW_MAX_BYTES / 3) * 4 + 4);
    expect(() => decodeAutomaticPreview(response, witness)).toThrow(
      "automatic_preview_invalid_response",
    );
  });

  it("rejects a changed PNG viewport even if the response labels still match", () => {
    const response = providerResponse();
    const bytes = Buffer.from(response.capture.base64, "base64");
    bytes.writeUInt32BE(1, 16);
    response.capture.base64 = bytes.toString("base64");
    response.capture.sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(() => decodeAutomaticPreview(response, witness)).toThrow(
      "automatic_preview_invalid_png",
    );
  });
});
