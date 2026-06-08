/**
 * Prerender dynamic public routes for SEO.
 *
 * Queries the database for published gallery templates and public community
 * profiles, then writes static HTML stubs into the mustaflow frontend build
 * output so crawlers see meaningful content in the initial HTTP response.
 *
 * Run after `pnpm --filter @workspace/mustaflow run build`:
 *   pnpm --filter @workspace/scripts run prerender-dynamic-routes
 *
 * Requires DATABASE_URL to be set.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { pool } from "@workspace/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DIST_DIR = join(__dirname, "..", "..", "artifacts", "mustaflow", "dist", "public");
const BASE_URL = "https://mustaflow.app";
const SITE_NAME = "MustaFlow AI";
const DEFAULT_IMAGE = `${BASE_URL}/opengraph.jpg`;

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface DynamicRoute {
  path: string;
  title: string;
  description: string;
  image?: string;
  body: string;
  jsonLd?: object;
}

function injectRoute(indexHtml: string, route: DynamicRoute): string {
  let html = indexHtml;
  const canonicalUrl = `${BASE_URL}${route.path}`;
  const image = route.image ?? DEFAULT_IMAGE;

  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(route.title)}</title>`);
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
    `<meta name="description" content="${escHtml(route.description)}" />`,
  );
  html = html.replace(
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
    `<link rel="canonical" href="${canonicalUrl}" />`,
  );
  html = html.replace(
    /<meta\s+name="robots"\s+content="[^"]*"\s*\/>/,
    `<meta name="robots" content="index, follow" />`,
  );
  html = html.replace(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:title" content="${escHtml(route.title)}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${escHtml(route.description)}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:url" content="${canonicalUrl}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:image"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:image" content="${image}" />`,
  );
  html = html.replace(
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:title" content="${escHtml(route.title)}" />`,
  );
  html = html.replace(
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:description" content="${escHtml(route.description)}" />`,
  );
  html = html.replace(
    /<meta\s+name="twitter:image"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:image" content="${image}" />`,
  );

  if (route.jsonLd) {
    const scriptBlock = `    <script type="application/ld+json">${JSON.stringify(route.jsonLd)}</script>`;
    html = html.replace("</head>", `${scriptBlock}\n  </head>`);
  }

  html = html.replace(
    /<div id="root"><\/div>/,
    `<div id="root"><div data-prerender-fallback>${route.body.trim()}</div></div>`,
  );

  return html;
}

function writeRoute(indexHtml: string, route: DynamicRoute): void {
  const segments = route.path.split("/").filter(Boolean);
  const outDir = join(DIST_DIR, ...segments);
  const outFile = join(outDir, "index.html");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, injectRoute(indexHtml, route), "utf-8");
  console.log(`[prerender-dynamic] ${route.path} → ${outFile.replace(DIST_DIR, "dist/public")}`);
}

const CATEGORY_LABELS: Record<string, string> = {
  web: "Web App",
  mobile: "Mobile",
  saas: "SaaS",
  ecommerce: "E-commerce",
  dashboard: "Dashboard",
  landing: "Landing Page",
  portfolio: "Portfolio",
  "internal-tools": "Internal Tools",
  "ai-app": "AI App",
  blog: "Blog",
  social: "Social",
  other: "Other",
};

async function run(): Promise<void> {
  // Graceful no-op when DATABASE_URL is absent — the script is wired into
  // the postbuild pipeline where DATABASE_URL may not be set (e.g. CI builds
  // without a live DB, local `pnpm build`). Static routes are still prerendered
  // by scripts/prerender.ts; this step only adds dynamic gallery/profile stubs.
  if (!process.env.DATABASE_URL) {
    console.log(
      "[prerender-dynamic] DATABASE_URL not set — skipping dynamic prerender (no DB available).",
    );
    process.exit(0);
  }

  // Prefer the lightweight public entry as template — fewer preloaded chunks.
  // Fall back to index.html if public.html was not emitted (legacy builds).
  const publicHtmlPath = join(DIST_DIR, "public.html");
  const indexHtmlPath = join(DIST_DIR, "index.html");
  const templatePath = existsSync(publicHtmlPath) ? publicHtmlPath : indexHtmlPath;

  if (!existsSync(templatePath)) {
    console.error(
      "[prerender-dynamic] dist/public/public.html and index.html not found — " +
        "run `pnpm --filter @workspace/mustaflow run build` first",
    );
    process.exit(1);
  }

  const indexHtml = readFileSync(templatePath, "utf-8");
  const client = await pool.connect();

  try {
    const [templatesResult, profilesResult] = await Promise.all([
      client.query<{
        slug: string;
        title: string;
        description: string;
        category: string;
        tags: string[];
        thumbnail_url: string | null;
      }>(
        `SELECT slug, title, description, category, tags, thumbnail_url
         FROM gallery_templates
         WHERE status = 'published'
         ORDER BY editors_pick DESC, rating DESC`,
      ),
      client.query<{
        username: string;
        display_name: string | null;
        bio: string | null;
      }>(
        `SELECT username, display_name, bio
         FROM community_profiles
         WHERE profile_public = true`,
      ),
    ]);

    let count = 0;

    for (const tpl of templatesResult.rows) {
      const categoryLabel = CATEGORY_LABELS[tpl.category] ?? tpl.category;
      const tags: string[] = Array.isArray(tpl.tags) ? tpl.tags : [];
      const tagsHtml =
        tags.length > 0
          ? `<ul aria-label="Tags">${tags.map((t) => `<li>${escHtml(t)}</li>`).join("")}</ul>`
          : "";

      const route: DynamicRoute = {
        path: `/gallery/${tpl.slug}`,
        title: `${tpl.title} — Template Gallery | ${SITE_NAME}`,
        description: tpl.description,
        image: tpl.thumbnail_url ?? DEFAULT_IMAGE,
        body: `
<main>
  <nav aria-label="Breadcrumb"><a href="/gallery">Template Gallery</a></nav>
  <article>
    <header>
      <h1>${escHtml(tpl.title)}</h1>
      <p>${escHtml(tpl.description)}</p>
      <p>Category: <a href="/gallery?category=${encodeURIComponent(tpl.category)}">${escHtml(categoryLabel)}</a></p>
      ${tagsHtml}
    </header>
    <section aria-label="Use this template">
      <a href="/sign-up">Use this template free</a>
      <a href="/gallery">Browse all templates</a>
    </section>
  </article>
</main>`,
        jsonLd: {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: tpl.title,
          description: tpl.description,
          applicationCategory: categoryLabel,
          url: `${BASE_URL}/gallery/${tpl.slug}`,
        },
      };

      writeRoute(indexHtml, route);
      count++;
    }

    for (const profile of profilesResult.rows) {
      const displayName = profile.display_name ?? profile.username;

      const route: DynamicRoute = {
        path: `/u/${profile.username}`,
        title: profile.display_name
          ? `${profile.display_name} (@${profile.username}) | ${SITE_NAME}`
          : `@${profile.username} | ${SITE_NAME}`,
        description:
          profile.bio ??
          `See the public apps and projects built by ${displayName} on MustaFlow AI.`,
        body: `
<main>
  <article>
    <header>
      <h1>${escHtml(displayName)}</h1>
      <p>@${escHtml(profile.username)}</p>
      ${profile.bio ? `<p>${escHtml(profile.bio)}</p>` : ""}
    </header>
    <nav aria-label="Profile navigation">
      <a href="/gallery">Template Gallery</a>
      <a href="/community">Community</a>
    </nav>
  </article>
</main>`,
        jsonLd: {
          "@context": "https://schema.org",
          "@type": "Person",
          name: displayName,
          url: `${BASE_URL}/u/${profile.username}`,
          ...(profile.bio ? { description: profile.bio } : {}),
        },
      };

      writeRoute(indexHtml, route);
      count++;
    }

    console.log(
      `[prerender-dynamic] Done — ${count} dynamic routes rendered (${templatesResult.rows.length} templates, ${profilesResult.rows.length} profiles).`,
    );
  } finally {
    client.release();
    await pool.end();
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("[prerender-dynamic] Fatal error:", err);
  process.exit(1);
});
