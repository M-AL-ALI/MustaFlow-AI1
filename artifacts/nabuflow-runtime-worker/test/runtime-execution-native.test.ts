import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Use the native engine already supplied by the pinned Wrangler dev dependency.
// This must not install packages or use the cloudflare:workers Vitest stub.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare } = wranglerRequire("miniflare");
const { buildSync } = wranglerRequire("esbuild");

it("native RPC fences late work and recovers after caller or coordinator hard loss", async () => {
  const bundle = buildSync({
    entryPoints: [
      fileURLToPath(new URL("./fixtures/runtime-execution-native-worker.mjs", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["cloudflare:workers"],
  });
  const pending = new Map<string, () => void>();
  const mf = new Miniflare({
    modules: true,
    // Inline compiled modules avoid a Windows workerd absolute scriptPath failure.
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    durableObjects: {
      COORD: { className: "GuardCoordinator", useSQLite: true },
      CALLER: { className: "Caller", useSQLite: true },
    },
    durableObjectsPersist: false,
    serviceBindings: {
      BACKEND: async (request: Request) => {
        const id = new URL(request.url).searchParams.get("id")!;
        await new Promise<void>((resolve) => {
          pending.set(id, resolve);
        });
        return new Response("released");
      },
    },
  });
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await delay(20);
    }
    throw new Error("Native RPC checkpoint timed out");
  };
  try {
    const base = (await mf.ready).origin as string;
    const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
    const state = async (id: string) =>
      (await (await request(`/state?id=${id}`)).json()) as { active: number; value: string | null };
    const normal = request("/start?id=normal");
    await until(() => pending.has("normal"));
    expect((await request("/delete?id=normal")).status).toBe(409);
    pending.get("normal")!();
    expect((await normal).status).toBe(200);
    expect((await request("/delete?id=normal")).status).toBe(200);
    expect(await state("normal")).toEqual({ active: 0, value: "absent" });

    const abort = new AbortController();
    const disconnected = request("/start?id=disconnect", { signal: abort.signal }).catch(
      () => null,
    );
    await until(() => pending.has("disconnect"));
    abort.abort();
    await disconnected;
    // Disconnect is not itself proof of quiescence; if work remains alive it stays guarded.
    const afterDisconnect = await state("disconnect");
    if (afterDisconnect.active > 0)
      expect((await request("/delete?id=disconnect")).status).toBe(409);
    pending.get("disconnect")!();
    await until(async () => (await state("disconnect")).active === 0);
    expect((await request("/delete?id=disconnect")).status).toBe(200);

    const callerCrashed = request("/caller-start").catch(() => null);
    await until(() => pending.has("callerCrash"));
    await request("/caller-crash").catch(() => null);
    await callerCrashed;
    await until(async () => (await state("callerCrash")).active === 0);
    expect((await request("/delete?id=callerCrash")).status).toBe(200);
    pending.get("callerCrash")!();
    await delay(150);
    expect(await state("callerCrash")).toEqual({ active: 0, value: "absent" });

    const coordinatorCrashed = request("/start?id=coordinatorCrash").catch(() => null);
    await until(() => pending.has("coordinatorCrash"));
    await request("/crash").catch(() => null);
    await coordinatorCrashed;
    expect((await request("/delete?id=coordinatorCrash")).status).toBe(200);
    pending.get("coordinatorCrash")!();
    await delay(150);
    expect(await state("coordinatorCrash")).toEqual({ active: 0, value: "absent" });
  } finally {
    for (const release of pending.values()) release();
    await mf.dispose();
  }
}, 15000);
