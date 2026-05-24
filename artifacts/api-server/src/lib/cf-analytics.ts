/**
 * Cloudflare GraphQL Analytics API client.
 * Returns traffic metrics for a hostname from the Cloudflare Analytics API.
 *
 * Gracefully returns null when CF credentials are not configured.
 * Results are cached in-process for 60 seconds.
 */

import { logger } from "./logger";
import { cfEnabled } from "./cloudflare";

const CF_GQL = "https://api.cloudflare.com/client/v4/graphql";

export type AnalyticsWindow = "24h" | "7d" | "30d";

export interface HostnameAnalytics {
  requests: number;
  cachedRequests: number;
  bytes: number;
  cachedBytes: number;
  threats: number;
  pageviews: number;
  errorRate: number;
  topCountries: Array<{ countryCode: string; requests: number }>;
  topPaths: Array<{ path: string; requests: number }>;
  window: AnalyticsWindow;
  fetchedAt: string;
}

interface CacheEntry {
  data: HostnameAnalytics;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(hostname: string, window: AnalyticsWindow): string {
  return `${hostname}:${window}`;
}

function windowToDates(window: AnalyticsWindow): { since: string; until: string } {
  const until = new Date();
  const since = new Date(until);
  if (window === "24h") since.setHours(since.getHours() - 24);
  else if (window === "7d") since.setDate(since.getDate() - 7);
  else since.setDate(since.getDate() - 30);
  return {
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
  };
}

function apiToken(): string {
  return process.env.CF_API_TOKEN!;
}

function zoneId(): string {
  return process.env.CF_ZONE_ID!;
}

/**
 * Fetch traffic analytics for a hostname from Cloudflare GraphQL Analytics API.
 * Returns null when CF is not configured or on error.
 */
export async function getHostnameAnalytics(
  hostname: string,
  window: AnalyticsWindow = "24h",
): Promise<HostnameAnalytics | null> {
  if (!cfEnabled()) return null;

  const key = cacheKey(hostname, window);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const { since, until } = windowToDates(window);

  const query = `
    {
      viewer {
        zones(filter: {zoneTag: "${zoneId()}"}) {
          httpRequestsAdaptiveGroups(
            filter: {
              date_geq: "${since}"
              date_leq: "${until}"
              clientRequestHTTPHost: "${hostname}"
            }
            limit: 1
            orderBy: [date_ASC]
          ) {
            sum {
              requests
              cachedRequests
              bytes
              cachedBytes
              threats
              pageViews
            }
          }
          httpRequestsAdaptiveCountries: httpRequestsAdaptiveGroups(
            filter: {
              date_geq: "${since}"
              date_leq: "${until}"
              clientRequestHTTPHost: "${hostname}"
            }
            limit: 10
            orderBy: [sum_requests_DESC]
          ) {
            sum { requests }
            dimensions { clientCountryName }
          }
        }
      }
    }
  `;

  try {
    const resp = await fetch(CF_GQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, hostname }, "CF Analytics non-OK response");
      return null;
    }

    type GqlResp = {
      data?: {
        viewer?: {
          zones?: Array<{
            httpRequestsAdaptiveGroups?: Array<{
              sum?: {
                requests?: number;
                cachedRequests?: number;
                bytes?: number;
                cachedBytes?: number;
                threats?: number;
                pageViews?: number;
              };
            }>;
            httpRequestsAdaptiveCountries?: Array<{
              sum?: { requests?: number };
              dimensions?: { clientCountryName?: string };
            }>;
          }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    const json = (await resp.json()) as GqlResp;

    if (json.errors?.length) {
      logger.warn({ errors: json.errors, hostname }, "CF Analytics GQL errors");
    }

    const zone = json.data?.viewer?.zones?.[0];
    const agg = zone?.httpRequestsAdaptiveGroups?.[0]?.sum;

    const requests = agg?.requests ?? 0;
    const cachedRequests = agg?.cachedRequests ?? 0;
    const bytes = agg?.bytes ?? 0;
    const cachedBytes = agg?.cachedBytes ?? 0;
    const threats = agg?.threats ?? 0;
    const pageviews = agg?.pageViews ?? 0;

    const errorRate = 0;

    const topCountries: HostnameAnalytics["topCountries"] = (
      zone?.httpRequestsAdaptiveCountries ?? []
    ).map((c) => ({
      countryCode: c.dimensions?.clientCountryName ?? "??",
      requests: c.sum?.requests ?? 0,
    }));

    const topPaths: HostnameAnalytics["topPaths"] = [];

    const result: HostnameAnalytics = {
      requests,
      cachedRequests,
      bytes,
      cachedBytes,
      threats,
      pageviews,
      errorRate,
      topCountries,
      topPaths,
      window,
      fetchedAt: new Date().toISOString(),
    };

    cache.set(key, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.warn({ err, hostname }, "CF Analytics fetch failed");
    return null;
  }
}

/** Purge cache entry (e.g. when a domain is detached). */
export function purgeAnalyticsCache(hostname: string): void {
  for (const w of ["24h", "7d", "30d"] as const) {
    cache.delete(cacheKey(hostname, w));
  }
}
