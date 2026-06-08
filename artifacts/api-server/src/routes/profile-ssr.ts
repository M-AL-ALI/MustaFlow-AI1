/**
 * Server-side rendered public profile pages at /u/:username.
 *
 * Serves profile HTML with data already embedded in the initial response so
 * that search engines, social bots, and AI crawlers (GPTBot, ClaudeBot) can
 * read the profile name, bio, and published project links without executing
 * JavaScript.
 *
 * In production the handler reads the built Vite index.html (which contains
 * the hashed script/stylesheet bundle tags) and injects profile-specific
 * metadata + body HTML into it, so the React SPA still loads and hydrates for
 * regular browser visitors after the static content is replaced via
 * createRoot().render().
 *
 * In development (dist/public/index.html not yet built) the handler falls
 * back to a minimal self-contained HTML page that carries the profile content
 * without React hydration — sufficient for SEO verification and dev testing.
 */

import { Router, type IRouter } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, communityProfilesTable, projectsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export const profileSsrRouter: IRouter = Router();

const BASE_URL = process.env["PLATFORM_DOMAIN"]
  ? `https://${process.env["PLATFORM_DOMAIN"]}`
  : "https://mustaflow.app";
const SITE_NAME = "MustaFlow AI";
const DEFAULT_OG_IMAGE = `${BASE_URL}/opengraph.jpg`;

const PLATFORM_LABELS: Record<string, string> = {
  web: "Web",
  cross: "Mobile",
  ios: "iOS",
  android: "Android",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildProfileHtml(
  username: string,
  profile: {
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
    websiteUrl: string | null;
    twitterHandle: string | null;
    githubHandle: string | null;
    location: string | null;
    followerCount: number;
    followingCount: number;
  },
  projects: Array<{
    id: number;
    name: string;
    description: string | null;
    platform: string;
    status: string;
    publicSlug: string | null;
  }>,
): { head: string; body: string } {
  const displayName = profile.displayName ?? username;
  const pageTitle = profile.displayName
    ? `${esc(profile.displayName)} (@${esc(username)}) | ${SITE_NAME}`
    : `@${esc(username)} | ${SITE_NAME}`;
  const pageDescription = profile.bio
    ? esc(profile.bio)
    : `See the public apps and projects built by ${esc(displayName)} on ${SITE_NAME}.`;
  const canonicalUrl = `${BASE_URL}/u/${encodeURIComponent(username)}`;
  const ogImage = profile.avatarUrl ? esc(profile.avatarUrl) : DEFAULT_OG_IMAGE;

  const head = `
    <title>${pageTitle}</title>
    <meta name="description" content="${pageDescription}" />
    <link rel="canonical" href="${canonicalUrl}" />
    <meta name="robots" content="index, follow" />
    <meta property="og:title" content="${pageTitle}" />
    <meta property="og:description" content="${pageDescription}" />
    <meta property="og:type" content="profile" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${pageTitle}" />
    <meta name="twitter:description" content="${pageDescription}" />
    <meta name="twitter:image" content="${ogImage}" />${
      profile.twitterHandle
        ? `\n    <meta name="twitter:creator" content="@${esc(profile.twitterHandle)}" />`
        : ""
    }`.trim();

  const projectLinks =
    projects.length === 0
      ? `<p>No public projects yet.</p>`
      : `<ul>${projects
          .map((p) => {
            const isPublished = p.status === "published" && p.publicSlug;
            const platformLabel = PLATFORM_LABELS[p.platform] ?? p.platform;
            const projectContent = `
            <strong>${esc(p.name)}</strong>
            ${p.description ? `<br>${esc(p.description)}` : ""}
            <br><small>${esc(platformLabel)}${isPublished ? " · Live" : ""}</small>`;
            return isPublished && p.publicSlug
              ? `<li><a href="/api/p/${esc(p.publicSlug)}/">${projectContent}</a></li>`
              : `<li>${projectContent}</li>`;
          })
          .join("")}</ul>`;

  const body = `
<main>
  <article aria-label="Profile for ${esc(displayName)}">
    <header>
      ${profile.avatarUrl ? `<img src="${esc(profile.avatarUrl)}" alt="${esc(displayName)}" width="64" height="64" />` : ""}
      <h1>${esc(displayName)}</h1>
      <p>@${esc(username)}</p>
      ${profile.bio ? `<p>${esc(profile.bio)}</p>` : ""}
      <p>${profile.followerCount} followers &middot; ${profile.followingCount} following</p>
      ${profile.location ? `<p>${esc(profile.location)}</p>` : ""}
      ${profile.websiteUrl ? `<p><a href="${esc(profile.websiteUrl)}" rel="noopener noreferrer">Website</a></p>` : ""}
      ${profile.twitterHandle ? `<p><a href="https://twitter.com/${esc(profile.twitterHandle)}" rel="noopener noreferrer">@${esc(profile.twitterHandle)} on X</a></p>` : ""}
      ${profile.githubHandle ? `<p><a href="https://github.com/${esc(profile.githubHandle)}" rel="noopener noreferrer">${esc(profile.githubHandle)} on GitHub</a></p>` : ""}
    </header>
    <section aria-label="Projects by ${esc(displayName)}">
      <h2>Projects (${projects.length})</h2>
      ${projectLinks}
    </section>
    <aside>
      <p>Built with <a href="${BASE_URL}">${SITE_NAME}</a></p>
    </aside>
  </article>
</main>`;

  return { head, body };
}

function buildNotFoundHtml(username: string): { head: string; body: string } {
  const head = `
    <title>Profile not found | ${SITE_NAME}</title>
    <meta name="description" content="The user @${esc(username)} hasn't created a public profile yet." />
    <meta name="robots" content="noindex, nofollow" />`.trim();
  const body = `
<main>
  <h1>Profile not found</h1>
  <p>The user <strong>@${esc(username)}</strong> hasn't created a public profile yet or doesn't exist.</p>
  <a href="${BASE_URL}/community">Browse the community</a>
</main>`;
  return { head, body };
}

/** Attempt to read the built Vite index.html from the monorepo root. */
function readBuiltIndexHtml(): string | null {
  try {
    const distPath = join(process.cwd(), "artifacts", "mustaflow", "dist", "public", "index.html");
    return readFileSync(distPath, "utf-8");
  } catch {
    return null;
  }
}

/** Inject head tags and body content into the built index.html. */
function injectIntoIndexHtml(indexHtml: string, headSnippet: string, bodyContent: string): string {
  let html = indexHtml;

  // Replace the entire <title> block
  html = html.replace(/<title>[^<]*<\/title>/, "");

  // Replace description
  html = html.replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/>/, "");

  // Remove existing canonical / robots / OG / Twitter tags if present
  html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/, "");
  html = html.replace(/<meta\s+name="robots"\s+content="[^"]*"\s*\/>/, "");
  html = html.replace(/<meta\s+property="og:[^"]*"\s+content="[^"]*"\s*\/>/g, "");
  html = html.replace(/<meta\s+name="twitter:[^"]*"\s+content="[^"]*"\s*\/>/g, "");

  // Inject the route-specific head block just before </head>
  html = html.replace("</head>", `  ${headSnippet}\n</head>`);

  // Inject body content into <div id="root"></div>
  html = html.replace(/<div id="root"><\/div>/, `<div id="root">${bodyContent.trim()}</div>`);

  return html;
}

/** Minimal standalone HTML for development (no Vite bundle needed). */
function buildMinimalHtml(headSnippet: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${headSnippet}
</head>
<body>
  ${bodyContent.trim()}
</body>
</html>`;
}

profileSsrRouter.get("/u/:username", async (req, res): Promise<void> => {
  const { username } = req.params as { username: string };

  try {
    const [profile] = await db
      .select({
        userId: communityProfilesTable.userId,
        username: communityProfilesTable.username,
        displayName: communityProfilesTable.displayName,
        bio: communityProfilesTable.bio,
        avatarUrl: communityProfilesTable.avatarUrl,
        websiteUrl: communityProfilesTable.websiteUrl,
        twitterHandle: communityProfilesTable.twitterHandle,
        githubHandle: communityProfilesTable.githubHandle,
        location: communityProfilesTable.location,
        showcasedProjectIds: communityProfilesTable.showcasedProjectIds,
        publicProjectIds: communityProfilesTable.publicProjectIds,
        followerCount: communityProfilesTable.followerCount,
        followingCount: communityProfilesTable.followingCount,
      })
      .from(communityProfilesTable)
      .where(
        and(
          eq(communityProfilesTable.username, username),
          eq(communityProfilesTable.profilePublic, true),
        ),
      );

    let headSnippet: string;
    let bodyContent: string;

    if (!profile) {
      const { head, body } = buildNotFoundHtml(username);
      headSnippet = head;
      bodyContent = body;
    } else {
      // Fetch public projects for this profile
      const showcasedIds = (profile.showcasedProjectIds as number[]) ?? [];
      const publicIds = (profile.publicProjectIds as number[]) ?? [];
      const allIds = [...new Set([...showcasedIds, ...publicIds])];

      const projects =
        allIds.length === 0
          ? []
          : await db
              .select({
                id: projectsTable.id,
                name: projectsTable.name,
                description: projectsTable.description,
                platform: projectsTable.platform,
                status: projectsTable.status,
                publicSlug: projectsTable.publicSlug,
              })
              .from(projectsTable)
              .where(and(inArray(projectsTable.id, allIds), isNull(projectsTable.deletedAt)));

      const { head, body } = buildProfileHtml(username, profile, projects);
      headSnippet = head;
      bodyContent = body;
    }

    // Try production path first: inject into the built Vite index.html so
    // the React SPA still hydrates for regular browsers.
    const builtHtml = readBuiltIndexHtml();
    let responseHtml: string;
    if (builtHtml) {
      responseHtml = injectIntoIndexHtml(builtHtml, headSnippet, bodyContent);
    } else {
      // Development fallback: serve a lightweight standalone page.
      responseHtml = buildMinimalHtml(headSnippet, bodyContent);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Short cache: allow CDN/proxy to cache for 60 s, browsers for 10 s.
    // Profile data changes infrequently but should not be stale for long.
    res.setHeader("Cache-Control", "public, max-age=10, s-maxage=60");
    res.status(200).send(responseHtml);
  } catch (err) {
    logger.error({ err, username }, "Failed to render profile SSR page");
    res.status(500).send("Internal server error");
  }
});
