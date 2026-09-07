import {
  ProductionDatabaseAllocator,
  ProductionDatabaseProviderError,
} from "../../src/production-database-allocator";

export default {
  async fetch(incoming: Request): Promise<Response> {
    const status = Number(new URL(incoming.url).searchParams.get("status") ?? "200");
    let calls = 0;
    let redirectMode: string | null = null;
    let authorizationMatches = false;
    const env = {
      CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production",
      NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED: "enabled",
      NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY:
        "\r\n synthetic-management-material-with-sufficient-length \r\n",
      NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID: "org-test",
      NABUFLOW_PRODUCTION_NEON_REGION_ID: "aws-us-east-1",
      NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS: "86400",
      NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS: "25",
    } as ConstructorParameters<typeof ProductionDatabaseAllocator>[0];
    const allocator = new ProductionDatabaseAllocator(env, {
      async fetch(request) {
        calls += 1;
        redirectMode = request.redirect;
        authorizationMatches =
          request.headers.get("authorization") ===
          "Bearer synthetic-management-material-with-sufficient-length";
        return status >= 300 && status < 400
          ? new Response(null, {
              status,
              headers: { location: "https://untrusted.invalid/credential-target" },
            })
          : Response.json({ projects: [] });
      },
    });
    try {
      const health = await allocator.healthCheck();
      return Response.json({ ok: true, calls, redirectMode, authorizationMatches, health });
    } catch (error) {
      if (!(error instanceof ProductionDatabaseProviderError)) throw error;
      return Response.json({
        ok: false,
        calls,
        redirectMode,
        authorizationMatches,
        status: error.status,
        code: error.code,
        causeClass: error.causeClass,
        providerStatus: error.providerStatus,
      });
    }
  },
};
