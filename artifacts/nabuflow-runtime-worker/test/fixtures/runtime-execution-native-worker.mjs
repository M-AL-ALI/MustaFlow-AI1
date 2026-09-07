/* global crypto, Request, Response, URL */
import { DurableObject } from "cloudflare:workers";
import { RuntimeExecutionRegistry } from "../../src/runtime-execution-guard.ts";

export class GuardCoordinator extends DurableObject {
  registry = new RuntimeExecutionRegistry();
  acquire(identity, exclusive) {
    return this.registry.acquire(identity, crypto.randomUUID(), exclusive);
  }
  count() {
    return this.registry.size;
  }
  async put(identity, value) {
    await this.ctx.storage.put(identity, value);
  }
  async read(identity) {
    return (await this.ctx.storage.get(identity)) ?? null;
  }
  crash() {
    this.ctx.abort("intentional test-only coordinator crash");
  }
}

export class Caller extends DurableObject {
  async start() {
    const coordinator = this.env.COORD.get(this.env.COORD.idFromName("control"));
    const lease = await coordinator.acquire("callerCrash", false);
    try {
      return await lease.run(async () => {
        await this.env.BACKEND.fetch(new Request("http://backend/hold?id=callerCrash"));
        await coordinator.put("callerCrash", "running");
        return { status: 200, body: { ok: true } };
      });
    } finally {
      await lease.close();
      lease[Symbol.dispose]();
    }
  }
  crash() {
    this.ctx.abort("intentional test-only caller crash");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const identity = url.searchParams.get("id") ?? "a";
    const coordinator = env.COORD.get(env.COORD.idFromName("control"));
    if (url.pathname === "/caller-start")
      return Response.json(await env.CALLER.get(env.CALLER.idFromName("caller")).start());
    if (url.pathname === "/caller-crash")
      return Response.json(await env.CALLER.get(env.CALLER.idFromName("caller")).crash());
    if (url.pathname === "/state")
      return Response.json({
        active: await coordinator.count(),
        value: await coordinator.read(identity),
      });
    if (url.pathname === "/crash") {
      await coordinator.crash();
      return new Response("unexpected");
    }
    const lease = await coordinator.acquire(identity, url.pathname === "/delete");
    if (lease === null) return Response.json({ busy: true }, { status: 409 });
    try {
      return Response.json(
        await lease.run(async () => {
          if (url.pathname === "/start") {
            await env.BACKEND.fetch(new Request(`http://backend/hold?id=${identity}`));
            await coordinator.put(identity, "running");
          } else if (url.pathname === "/delete") await coordinator.put(identity, "absent");
          return { status: 200, body: { ok: true } };
        }),
      );
    } finally {
      await lease.close();
      lease[Symbol.dispose]();
    }
  },
};
