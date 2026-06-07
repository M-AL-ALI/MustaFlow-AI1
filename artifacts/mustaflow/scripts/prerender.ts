/**
 * Post-build prerender script.
 *
 * After `vite build` produces dist/public/index.html, this script copies it
 * to each known static public route (e.g. dist/public/gallery/index.html)
 * and injects per-route <title>, <meta name="description">, <link rel="canonical">,
 * and Open Graph / Twitter tags directly into the static HTML.
 *
 * Social bots and AI crawlers that do not execute JavaScript will therefore
 * receive accurate, route-specific metadata in the initial HTTP response —
 * without requiring SSR or a headless browser.
 *
 * Run: tsx scripts/prerender.ts
 * (called automatically by `pnpm build` via the postbuild npm script)
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "dist", "public");
const BASE_URL = "https://mustaflow.app";
const SITE_NAME = "MustaFlow AI";
const DEFAULT_IMAGE = `${BASE_URL}/opengraph.jpg`;

interface RouteMetadata {
  path: string;
  title: string;
  description: string;
  image?: string;
  noIndex?: boolean;
}

const PUBLIC_ROUTES: RouteMetadata[] = [
  {
    path: "/",
    title: `${SITE_NAME} | AI App Builder for Web, Mobile, and Templates`,
    description:
      "Build websites, apps, and workflows with AI. MustaFlow helps you brainstorm ideas, start from templates, generate code, and publish faster.",
  },
  {
    path: "/gallery",
    title: `Template Gallery | ${SITE_NAME}`,
    description:
      "Browse hundreds of community-built and official app templates across every category. Start your next project in seconds with MustaFlow AI.",
  },
  {
    path: "/extensions",
    title: `Extensions Marketplace | ${SITE_NAME}`,
    description:
      "Discover and install extensions to supercharge your MustaFlow AI projects. Add integrations, tools, and capabilities to your apps.",
  },
  {
    path: "/community",
    title: `Community | ${SITE_NAME}`,
    description:
      "Join the MustaFlow AI builder community. Share apps, explore public templates, and learn from top builders on the platform.",
  },
  {
    path: "/pricing",
    title: `Pricing | ${SITE_NAME}`,
    description:
      "Simple, transparent pricing for every stage of building. Start free and scale up with MustaFlow AI — no credit card required.",
  },
  {
    path: "/trust",
    title: `Trust & Security | ${SITE_NAME}`,
    description:
      "MustaFlow AI's security posture, compliance certifications, encryption practices, and data protection commitments.",
  },
  {
    path: "/developers",
    title: `Developers | ${SITE_NAME}`,
    description:
      "Build on MustaFlow AI with our public API. Manage projects, trigger builds, publish apps, and integrate with your own tools.",
  },
  {
    path: "/developers/changelog",
    title: `API Changelog | ${SITE_NAME}`,
    description:
      "Track changes to the MustaFlow public API. View new endpoints, deprecations, and breaking changes by release date.",
  },
  {
    path: "/help",
    title: `Help Center | ${SITE_NAME}`,
    description:
      "Get answers to common questions about building with MustaFlow AI. Browse help articles or contact support.",
  },
  {
    path: "/help/domains-api",
    title: `Custom Domains & API Guide | ${SITE_NAME}`,
    description:
      "Learn how to connect a custom domain, configure DNS, and use the MustaFlow public API to manage and publish your apps.",
  },
  {
    path: "/status",
    title: `System Status | ${SITE_NAME}`,
    description:
      "Live status and uptime for MustaFlow AI services — builder, preview, publishing, AI generation, and more.",
  },
  {
    path: "/terms",
    title: `Terms of Service | ${SITE_NAME}`,
    description:
      "Read the MustaFlow AI Terms of Service. Learn about acceptable use, intellectual property, and your rights as a user.",
    noIndex: true,
  },
  {
    path: "/privacy",
    title: `Privacy Policy | ${SITE_NAME}`,
    description:
      "Learn how MustaFlow AI collects, uses, and protects your data. We are committed to privacy and transparency.",
    noIndex: true,
  },
];

function buildHead(meta: RouteMetadata): string {
  const canonicalUrl = `${BASE_URL}${meta.path}`;
  const image = meta.image ?? DEFAULT_IMAGE;
  const robots = meta.noIndex ? "noindex, nofollow" : "index, follow";

  return `
    <title>${meta.title}</title>
    <meta name="description" content="${meta.description}" />
    <link rel="canonical" href="${canonicalUrl}" />
    <meta name="robots" content="${robots}" />
    <meta property="og:title" content="${meta.title}" />
    <meta property="og:description" content="${meta.description}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:image" content="${image}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${meta.title}" />
    <meta name="twitter:description" content="${meta.description}" />
    <meta name="twitter:image" content="${image}" />`.trim();
}

// Replaces the entire <head> metadata block (title, description, OG, Twitter,
// canonical, robots) with route-specific values. Keeps everything else
// (charset, viewport, icons, fonts, scripts) intact.
function injectMetadata(html: string, meta: RouteMetadata): string {
  const newHead = buildHead(meta);

  // Replace the title tag
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${meta.title}</title>`);

  // Replace description
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
    `<meta name="description" content="${meta.description}" />`,
  );

  // Replace canonical
  const canonicalUrl = `${BASE_URL}${meta.path}`;
  if (html.includes('rel="canonical"')) {
    html = html.replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
      `<link rel="canonical" href="${canonicalUrl}" />`,
    );
  } else {
    html = html.replace(
      "</title>",
      `</title>\n    <link rel="canonical" href="${canonicalUrl}" />`,
    );
  }

  // Replace robots
  const robots = meta.noIndex ? "noindex, nofollow" : "index, follow";
  html = html.replace(
    /<meta\s+name="robots"\s+content="[^"]*"\s*\/>/,
    `<meta name="robots" content="${robots}" />`,
  );

  // Replace OG tags
  html = html.replace(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:title" content="${meta.title}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${meta.description}" />`,
  );
  html = html.replace(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:url" content="${canonicalUrl}" />`,
  );

  // Replace Twitter tags
  html = html.replace(
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:title" content="${meta.title}" />`,
  );
  html = html.replace(
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/,
    `<meta name="twitter:description" content="${meta.description}" />`,
  );

  return html;
}

function prerender(): void {
  let indexHtml: string;
  try {
    indexHtml = readFileSync(join(distDir, "index.html"), "utf-8");
  } catch {
    console.error(`[prerender] dist/public/index.html not found — run vite build first`);
    process.exit(1);
  }

  let rendered = 0;
  for (const route of PUBLIC_ROUTES) {
    const routePath = route.path === "/" ? "" : route.path;
    const outDir = join(distDir, ...routePath.split("/").filter(Boolean));
    const outFile = join(outDir, "index.html");

    const routeHtml = injectMetadata(indexHtml, route);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, routeHtml, "utf-8");
    console.log(`[prerender] ${route.path} → ${outFile.replace(distDir, "dist/public")}`);
    rendered++;
  }

  console.log(`[prerender] Done — ${rendered} routes rendered.`);
}

prerender();
