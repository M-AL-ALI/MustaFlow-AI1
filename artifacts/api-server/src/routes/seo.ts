/**
 * SEO routes — served before the auth wall so crawlers can access them.
 *
 *   GET /sitemap.xml          — dynamic XML sitemap including gallery templates + public profiles
 */
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, galleryTemplatesTable, communityProfilesTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const seoRouter: IRouter = Router();

const BASE_URL = "https://mustaflow.app";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function urlEntry(
  loc: string,
  opts: { changefreq?: string; priority?: string; lastmod?: Date } = {},
): string {
  const locEscaped = xmlEscape(loc);
  const parts = [`  <url>`, `    <loc>${locEscaped}</loc>`];
  if (opts.lastmod) {
    parts.push(`    <lastmod>${opts.lastmod.toISOString().split("T")[0]}</lastmod>`);
  }
  if (opts.changefreq) parts.push(`    <changefreq>${opts.changefreq}</changefreq>`);
  if (opts.priority) parts.push(`    <priority>${opts.priority}</priority>`);
  parts.push(`  </url>`);
  return parts.join("\n");
}

/** Static public routes always present in the sitemap */
const STATIC_URLS = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/pricing", changefreq: "weekly", priority: "0.9" },
  { path: "/gallery", changefreq: "daily", priority: "0.8" },
  { path: "/extensions", changefreq: "weekly", priority: "0.7" },
  { path: "/community", changefreq: "daily", priority: "0.7" },
  { path: "/help", changefreq: "weekly", priority: "0.8" },
  { path: "/help/domains-api", changefreq: "monthly", priority: "0.6" },
  { path: "/developers", changefreq: "weekly", priority: "0.7" },
  { path: "/developers/changelog", changefreq: "weekly", priority: "0.6" },
  { path: "/trust", changefreq: "monthly", priority: "0.7" },
  { path: "/status", changefreq: "hourly", priority: "0.6" },
  { path: "/privacy", changefreq: "monthly", priority: "0.5" },
  { path: "/terms", changefreq: "monthly", priority: "0.5" },
];

// GET /sitemap.xml — full dynamic sitemap
seoRouter.get("/sitemap.xml", async (req, res): Promise<void> => {
  try {
    const [templates, profiles] = await Promise.all([
      db
        .select({
          slug: galleryTemplatesTable.slug,
          publishedAt: galleryTemplatesTable.publishedAt,
          updatedAt: galleryTemplatesTable.updatedAt,
        })
        .from(galleryTemplatesTable)
        .where(eq(galleryTemplatesTable.status, "published")),
      db
        .select({
          username: communityProfilesTable.username,
          updatedAt: communityProfilesTable.updatedAt,
        })
        .from(communityProfilesTable)
        .where(and(eq(communityProfilesTable.profilePublic, true))),
    ]);

    const parts: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ];

    // Static routes
    for (const u of STATIC_URLS) {
      parts.push(urlEntry(`${BASE_URL}${u.path}`, u));
    }

    // Dynamic gallery template pages
    for (const t of templates) {
      parts.push(
        urlEntry(`${BASE_URL}/gallery/${encodeURIComponent(t.slug)}`, {
          lastmod: t.publishedAt ?? t.updatedAt,
          changefreq: "monthly",
          priority: "0.7",
        }),
      );
    }

    // Dynamic public profile pages
    for (const p of profiles) {
      parts.push(
        urlEntry(`${BASE_URL}/u/${encodeURIComponent(p.username)}`, {
          lastmod: p.updatedAt,
          changefreq: "weekly",
          priority: "0.6",
        }),
      );
    }

    parts.push(`</urlset>`);

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
    res.send(parts.join("\n"));
  } catch (err) {
    logger.error({ err }, "Failed to generate sitemap");
    res.status(500).send('<?xml version="1.0"?><error>Sitemap unavailable</error>');
  }
});
