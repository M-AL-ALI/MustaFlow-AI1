/**
 * Post-build prerender script.
 *
 * After `vite build` produces dist/public/index.html, this script copies it
 * to each known static public route (e.g. dist/public/gallery/index.html)
 * and injects per-route <title>, <meta name="description">, <link rel="canonical">,
 * Open Graph / Twitter tags, and static body HTML directly into the static HTML.
 *
 * The static body HTML gives AI crawlers (GPTBot, ClaudeBot) and other
 * non-JS bots the actual page headings, copy, and links in the initial HTTP
 * response — not just an empty <div id="root"></div>. Browsers still load the
 * full React SPA which replaces the static body via createRoot().render().
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
  jsonLd?: object;
  body?: string;
}

/**
 * Static FAQ seed — mirrors HELP_ARTICLE_SEED (lib/db/src/help-center-seed.ts)
 * for the items where isFaq=true. Keep in sync when new FAQ entries are added
 * to the seed so prerendered HTML stays accurate.
 */
const STATIC_FAQS = [
  {
    title: "What is NabuFlow?",
    body: "NabuFlow is an AI-powered app builder for non-technical users. You describe an app idea in natural language and NabuFlow plans, builds, previews, and helps you publish it. It supports static web apps, React apps, full-stack Node.js apps, and native mobile apps.",
  },
  {
    title: "Do I need to know how to code?",
    body: "No. You describe what you want in plain language and the AI Builder writes the code for you. You can review and refine the result through chat without editing code yourself, though the files are available if you want them.",
  },
  {
    title: "Can I build mobile apps?",
    body: "Yes. When your prompt describes a mobile app, NabuFlow automatically uses its mobile pipeline to generate a native Expo / React Native app. You do not need to change any setting; the stack is detected from your description.",
  },
  {
    title: "How do I contact support?",
    body: "Use Ask Ora in the Help Center for instant help. Ora can troubleshoot most issues using these help articles and your account details. If Ora cannot resolve your problem, use Escalate to support to open a ticket that is sent to our support team with your conversation and any screenshots you attach.",
  },
];

const HELP_FAQ_JSONLD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: STATIC_FAQS.map((f) => ({
    "@type": "Question",
    name: f.title,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.body,
    },
  })),
};

const PUBLIC_ROUTES: RouteMetadata[] = [
  {
    path: "/",
    title: `${SITE_NAME} | AI App Builder for Web, Mobile, and Templates`,
    description:
      "Build websites, apps, and workflows with AI. NabuFlow helps you brainstorm ideas, start from templates, generate code, and publish faster.",
    body: `
<main>
  <section aria-label="Hero">
    <h1>Build. Debug. Deploy.</h1>
    <p>Describe it or write it — NabuFlow plans, builds, tests, and ships your app, whether you code or not.</p>
    <a href="/sign-up">Start Building</a>
  </section>
  <section aria-label="What you can build">
    <h2>What do you want to build?</h2>
    <ul>
      <li>Brainstorm an idea — get AI help thinking through what to build and how it should work</li>
      <li>Mobile app — iOS and Android apps built with Expo and React Native</li>
      <li>Web app — full-stack web applications with database and API</li>
      <li>Landing page — clean, modern landing pages with hero, features, and signup</li>
      <li>Dashboard — metric dashboards with charts, filters, and live updates</li>
      <li>AI chatbot — conversational AI apps with chat history</li>
      <li>Slide deck — pitch decks and presentations with AI-generated slides</li>
      <li>Data automation — automations that run on a schedule and email summaries</li>
    </ul>
  </section>
  <section aria-label="How it works">
    <h2>How it works</h2>
    <ol>
      <li>
        <h3>Describe your idea</h3>
        <p>Write what you want to build in plain language. No jargon, no templates — just your idea.</p>
      </li>
      <li>
        <h3>AI builds it for you</h3>
        <p>NabuFlow plans, codes, and assembles your app in seconds. Preview it live as it takes shape.</p>
      </li>
      <li>
        <h3>Publish instantly</h3>
        <p>One click publishes your app to a public URL. Share it with anyone, no setup required.</p>
      </li>
    </ol>
  </section>
  <section aria-label="Key capabilities">
    <h2>Everything you need to ship</h2>
    <ul>
      <li>GitHub push and pull request integration</li>
      <li>Real terminal shell via Fly.io exec WebSocket</li>
      <li>Remote DAP debugging for running containers</li>
      <li>API tokens and full REST API access</li>
      <li>Semgrep and CVE dependency scanning on every build</li>
      <li>40+ managed blueprints: Postgres, Redis, queues, object storage, and more</li>
      <li>Static HTML, React SPA, full-stack Node.js, and native mobile (Expo/React Native)</li>
    </ul>
  </section>
  <nav aria-label="Platform links">
    <a href="/gallery">Template Gallery</a>
    <a href="/extensions">Extensions Marketplace</a>
    <a href="/pricing">Pricing</a>
    <a href="/community">Community</a>
    <a href="/developers">Developer Portal</a>
  </nav>
</main>`,
  },
  {
    path: "/gallery",
    title: `Template Gallery | ${SITE_NAME}`,
    description:
      "Browse hundreds of community-built and official app templates across every category. Start your next project in seconds with NabuFlow.",
    body: `
<main>
  <section aria-label="Gallery header">
    <h1>Template Gallery</h1>
    <p>Browse community-built and official app templates across every category. Start your next project in seconds with NabuFlow.</p>
  </section>
  <nav aria-label="Template categories">
    <h2>Browse by category</h2>
    <ul>
      <li><a href="/gallery">All templates</a></li>
      <li><a href="/gallery?category=web">Web App templates</a></li>
      <li><a href="/gallery?category=mobile">Mobile App templates</a></li>
      <li><a href="/gallery?category=saas">SaaS templates</a></li>
      <li><a href="/gallery?category=ecommerce">E-commerce templates</a></li>
      <li><a href="/gallery?category=dashboard">Dashboard templates</a></li>
      <li><a href="/gallery?category=landing">Landing Page templates</a></li>
      <li><a href="/gallery?category=portfolio">Portfolio templates</a></li>
      <li><a href="/gallery?category=internal-tools">Internal Tools templates</a></li>
      <li><a href="/gallery?category=ai-app">AI App templates</a></li>
      <li><a href="/gallery?category=blog">Blog templates</a></li>
      <li><a href="/gallery?category=social">Social templates</a></li>
    </ul>
  </nav>
  <section aria-label="Get started">
    <h2>Start from a template or describe your idea</h2>
    <p>Every template is fully customisable with AI. Pick one and describe what you want to change, or start from scratch with a prompt.</p>
    <a href="/sign-up">Get started free</a>
  </section>
</main>`,
  },
  {
    path: "/extensions",
    title: `Extensions Marketplace | ${SITE_NAME}`,
    description:
      "Discover and install extensions to supercharge your NabuFlow projects. Add integrations, tools, and capabilities to your apps.",
    body: `
<main>
  <section aria-label="Extensions header">
    <h1>Extensions</h1>
    <p>Discover and install extensions to supercharge your NabuFlow projects. Add integrations, tools, and capabilities to your apps.</p>
  </section>
  <nav aria-label="Extension categories">
    <h2>Browse by category</h2>
    <ul>
      <li>All extensions</li>
      <li>Productivity</li>
      <li>AI integrations</li>
      <li>Data extensions</li>
      <li>Analytics</li>
      <li>Developer Tools</li>
      <li>Third-party Integrations</li>
    </ul>
  </nav>
  <section aria-label="Extension capabilities">
    <h2>What extensions can do</h2>
    <ul>
      <li>Read and write project files</li>
      <li>Call AI models</li>
      <li>Access environment variables and secrets</li>
      <li>Trigger builds</li>
      <li>Read build logs</li>
    </ul>
  </section>
  <section aria-label="Build an extension">
    <h2>Build your own extension</h2>
    <p>Extensions are described by a <code>manifest.json</code> file. Declare a name, version, description, scopes, and an entrypoint URL. Once submitted, your extension can be listed in the marketplace for other builders to install.</p>
    <a href="/developers">Read the developer docs</a>
  </section>
</main>`,
  },
  {
    path: "/community",
    title: `Community | ${SITE_NAME}`,
    description:
      "Join the NabuFlow builder community. Share apps, explore public templates, and learn from top builders on the platform.",
    body: `
<main>
  <section aria-label="Community header">
    <h1>Community</h1>
    <p>Build with others. Share your work. Learn from the best builders on the platform.</p>
  </section>
  <section aria-label="Platform stats">
    <h2>NabuFlow by the numbers</h2>
    <ul>
      <li>150+ templates published</li>
      <li>2,400+ community builders</li>
      <li>18,000+ projects created</li>
      <li>940+ knowledge lessons shared</li>
    </ul>
  </section>
  <nav aria-label="Community resources">
    <h2>Explore the community</h2>
    <ul>
      <li>
        <h3><a href="/gallery">Template Gallery</a></h3>
        <p>Browse 100s of community-built and official templates across every category.</p>
      </li>
      <li>
        <h3><a href="/library">Public Library</a></h3>
        <p>Shared AI lessons and build knowledge from builders across the platform.</p>
      </li>
      <li>
        <h3><a href="/settings">Your Profile</a></h3>
        <p>Create a public profile to showcase your published projects and follow other builders.</p>
      </li>
    </ul>
  </nav>
  <section aria-label="Built with NabuFlow badge">
    <h2>Built with NabuFlow badge</h2>
    <p>Add a badge to your published sites to show they were built with NabuFlow. Visitors can click it to discover more apps and builders on the platform.</p>
  </section>
</main>`,
  },
  {
    path: "/pricing",
    title: `Pricing | ${SITE_NAME}`,
    description:
      "Simple, transparent pricing for every stage of building. Start free and scale up with NabuFlow — no credit card required.",
    body: `
<main>
  <section aria-label="Pricing header">
    <h1>Simple, transparent pricing</h1>
    <p>Start free and scale up with NabuFlow. No credit card required to get started.</p>
  </section>
  <section aria-label="Plans">
    <h2>Plans</h2>
    <article aria-label="Free plan">
      <h3>Free</h3>
      <p>Get started building with AI at no cost.</p>
      <ul>
        <li>30 Ora messages every 5 hours</li>
        <li>4 Ora images every 5 hours</li>
        <li>Unlimited file uploads to Ora</li>
        <li>150 Builder credits per month</li>
        <li>1 concurrent build</li>
        <li>Static, React SPA, and full-stack projects</li>
        <li>Community support</li>
      </ul>
      <a href="/sign-up">Get started free</a>
    </article>
    <article aria-label="Core plan">
      <h3>Core</h3>
      <p>More power for active builders.</p>
      <ul>
        <li>100 Ora messages every 3 hours</li>
        <li>15 Ora images every 3 hours</li>
        <li>Unlimited file uploads to Ora</li>
        <li>Ora Instant and Deep Thinking modes</li>
        <li>1,500 Builder credits per month</li>
        <li>Connectors (GitHub and more)</li>
        <li>3 concurrent builds</li>
        <li>No badge on published apps</li>
        <li>Priority build queue</li>
        <li>Email support</li>
      </ul>
    </article>
    <article aria-label="Wave plan">
      <h3>Wave</h3>
      <p>Maximum output for power builders.</p>
      <ul>
        <li>280 Ora messages every 3 hours</li>
        <li>30 Ora images every 3 hours</li>
        <li>Unlimited file uploads to Ora</li>
        <li>Ora Instant and Deep Thinking modes</li>
        <li>4,000 Builder credits per month</li>
        <li>Connectors (GitHub and more)</li>
        <li>10 concurrent builds</li>
        <li>No badge on published apps</li>
        <li>Priority build queue</li>
        <li>Priority support</li>
      </ul>
    </article>
  </section>
  <section aria-label="Builder credits">
    <h2>Builder credits</h2>
    <p>Builder credits are used when the AI builds or refines your project. Current build credit costs are shown on the live pricing page.</p>
  </section>
  <section aria-label="Ora usage limits">
    <h2>Ora AI assistant limits by plan</h2>
    <table>
      <thead><tr><th>Plan</th><th>Messages</th><th>Images</th><th>Deep Thinking</th></tr></thead>
      <tbody>
        <tr><td>Free</td><td>30 per 5 hours</td><td>4 per 5 hours</td><td>Not included</td></tr>
        <tr><td>Core</td><td>100 per 3 hours</td><td>15 per 3 hours</td><td>Included</td></tr>
        <tr><td>Wave</td><td>280 per 3 hours</td><td>30 per 3 hours</td><td>Included</td></tr>
      </tbody>
    </table>
  </section>
</main>`,
  },
  {
    path: "/trust",
    title: `Trust & Security | ${SITE_NAME}`,
    description:
      "MustaFlow AI's security posture, compliance certifications, encryption practices, and data protection commitments.",
    body: `
<main>
  <section aria-label="Trust and security header">
    <h1>Trust &amp; Security</h1>
    <p>MustaFlow AI is built with security and compliance as a foundation, not an afterthought. This page documents our posture so enterprise customers, auditors, and curious users can evaluate our controls.</p>
    <p>Last reviewed: May 2026</p>
  </section>
  <section aria-label="Certifications">
    <h2>Certification Status</h2>
    <ul>
      <li>SOC 2 Type II — In Progress</li>
      <li>GDPR Ready</li>
      <li>HIPAA — Enterprise tier</li>
    </ul>
  </section>
  <section aria-label="Encryption">
    <h2>Encryption</h2>
    <p>All data is encrypted in transit using TLS 1.2+. Sensitive values such as project secrets and API keys are encrypted at rest using AES-256-GCM before being stored in the database. Secret values are never returned in plaintext from the API — only a masked preview is shown.</p>
  </section>
  <section aria-label="Infrastructure security">
    <h2>Infrastructure</h2>
    <p>MustaFlow AI runs on Fly.io infrastructure with isolated container machines per project. Network egress is controlled. Build containers are ephemeral and destroyed after each build.</p>
  </section>
  <section aria-label="Application security">
    <h2>Application Security</h2>
    <p>Automated SAST (Semgrep) and CVE dependency scanning run on every build. Findings surface in the Checks tab of each project. We conduct regular internal security reviews and welcome responsible disclosure.</p>
  </section>
  <section aria-label="Data protection">
    <h2>Data Protection &amp; Privacy</h2>
    <p>Users can export all their data (projects, AI chat history, knowledge vault entries) at any time from Settings. Account and project data can be deleted on request. Secret values are excluded from all exports.</p>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Service</a>
  </section>
  <section aria-label="Vulnerability disclosure">
    <h2>Vulnerability Disclosure</h2>
    <p>If you discover a security vulnerability, please disclose it responsibly by emailing our security team. We aim to acknowledge reports within 48 hours and provide a resolution timeline within 7 days.</p>
  </section>
</main>`,
  },
  {
    path: "/developers",
    title: `Developers | ${SITE_NAME}`,
    description:
      "Build on NabuFlow with our public API. Manage projects, trigger builds, publish apps, and integrate with your own tools.",
    body: `
<main>
  <section aria-label="Developer portal header">
    <h1>Developer Portal</h1>
    <p>Build on NabuFlow with our public REST API and developer tools. Manage projects, trigger builds, publish apps, and integrate NabuFlow into your own workflows.</p>
  </section>
  <nav aria-label="API sections">
    <h2>API Documentation</h2>
    <ul>
      <li><a href="/developers#auth">Authentication — Personal Access Tokens</a></li>
      <li><a href="/developers#projects">Projects — create, list, get, delete</a></li>
      <li><a href="/developers#builds">Builds — trigger and monitor AI builds</a></li>
      <li><a href="/developers#publish">Publishing — publish and promote versions</a></li>
      <li><a href="/developers#secrets">Secrets — manage project environment variables</a></li>
      <li><a href="/developers#domains">Custom domains — add and verify domains</a></li>
      <li><a href="/developers#webhooks">Webhooks — receive build and deploy events</a></li>
    </ul>
  </nav>
  <section aria-label="Authentication">
    <h2>Authentication</h2>
    <p>The NabuFlow public API uses Personal Access Tokens (PATs) for authentication. Generate a token from Settings, then pass it as a Bearer token in the Authorization header of every request.</p>
    <p>Base URL: <code>https://mustaflow.app/api/v1</code></p>
  </section>
  <section aria-label="Developer features">
    <h2>Developer features</h2>
    <ul>
      <li>GitHub push and pull request integration</li>
      <li>Real terminal shell access via WebSocket</li>
      <li>Remote Debug Adapter Protocol (DAP) debugging</li>
      <li>Personal Access Tokens for REST API access</li>
      <li>Semgrep SAST and CVE dependency scanning</li>
      <li>40+ managed infrastructure blueprints</li>
      <li>Webhook events for build, publish, and deploy lifecycle</li>
    </ul>
  </section>
  <section aria-label="Related resources">
    <h2>Related resources</h2>
    <ul>
      <li><a href="/developers/changelog">API Changelog</a></li>
      <li><a href="/help/domains-api">Custom Domains &amp; API Guide</a></li>
      <li><a href="/extensions">Extensions Marketplace</a></li>
      <li><a href="/trust">Trust &amp; Security</a></li>
    </ul>
  </section>
</main>`,
  },
  {
    path: "/developers/changelog",
    title: `API Changelog | ${SITE_NAME}`,
    description:
      "Track changes to the NabuFlow public API. View new endpoints, deprecations, and breaking changes by release date.",
    body: `
<main>
  <section aria-label="Changelog header">
    <h1>API Changelog</h1>
    <p>Track changes to the NabuFlow public API. View new endpoints, deprecations, and breaking changes by release date.</p>
  </section>
  <nav aria-label="Developer navigation">
    <a href="/developers">Developer Portal</a>
    <a href="/help/domains-api">Custom Domains &amp; API Guide</a>
  </nav>
</main>`,
  },
  {
    path: "/help",
    title: `Help Center | ${SITE_NAME}`,
    description:
      "Get answers to common questions about building with NabuFlow. Browse help articles or contact support.",
    jsonLd: HELP_FAQ_JSONLD,
    body: `
<main>
  <section aria-label="Help center header">
    <h1>Help Center</h1>
    <p>Browse guides and FAQs, or ask Ora Support for help. Our AI support assistant can answer most questions instantly; you can escalate to the human support team from within the chat.</p>
  </section>
  <section aria-label="Help categories">
    <h2>Browse help topics</h2>
    <ul>
      <li>Getting started with NabuFlow</li>
      <li>AI Builder — building and refining projects</li>
      <li>Publishing and custom domains</li>
      <li>Credits and billing</li>
      <li>Account and sign-in</li>
      <li>Extensions and integrations</li>
      <li>Mobile app development</li>
      <li>Secrets and environment variables</li>
    </ul>
  </section>
  <section aria-label="Frequently asked questions">
    <h2>Frequently asked questions</h2>
    <dl>
      <dt>What is NabuFlow?</dt>
      <dd>NabuFlow is an AI-powered app builder for non-technical users. You describe an app idea in natural language and NabuFlow plans, builds, previews, and helps you publish it. It supports static web apps, React apps, full-stack Node.js apps, and native mobile apps.</dd>
      <dt>Do I need to know how to code?</dt>
      <dd>No. You describe what you want in plain language and the AI Builder writes the code for you. You can review and refine the result through chat without editing code yourself, though the files are available if you want them.</dd>
      <dt>Can I build mobile apps?</dt>
      <dd>Yes. When your prompt describes a mobile app, NabuFlow automatically uses its mobile pipeline to generate a native Expo / React Native app. You do not need to change any setting; the stack is detected from your description.</dd>
      <dt>How do I contact support?</dt>
      <dd>Use Ask Ora in the Help Center for instant help. Ora can troubleshoot most issues using these help articles and your account details. If Ora cannot resolve your problem, use Escalate to support to open a ticket that is sent to our support team with your conversation and any screenshots you attach.</dd>
    </dl>
  </section>
  <section aria-label="Contact support">
    <h2>Contact support</h2>
    <p>Sign in to chat with Ora Support and open a support ticket with the MustaFlow team.</p>
    <a href="/sign-in">Sign in to get help</a>
  </section>
  <nav aria-label="Help resources">
    <a href="/help/domains-api">Custom Domains &amp; API Guide</a>
    <a href="/developers">Developer Portal</a>
    <a href="/trust">Trust &amp; Security</a>
    <a href="/status">System Status</a>
  </nav>
</main>`,
  },
  {
    path: "/help/domains-api",
    title: `Custom Domains & API Guide | ${SITE_NAME}`,
    description:
      "Learn how to connect a custom domain, configure DNS, and use the NabuFlow public API to manage and publish your apps.",
    body: `
<main>
  <section aria-label="Guide header">
    <h1>Custom Domains &amp; API Guide</h1>
    <p>Learn how to connect a custom domain to your NabuFlow app, configure DNS records, and use the public REST API to manage and publish your projects programmatically.</p>
  </section>
  <section aria-label="Custom domains">
    <h2>Custom Domains</h2>
    <p>Every published NabuFlow app gets a free subdomain on <code>mustaflow.app</code>. You can also connect your own domain by adding a CNAME record pointing to <code>hosted.mustaflow.app</code> and entering the domain in the Publishing tab of your project.</p>
    <h3>How to connect a custom domain</h3>
    <ol>
      <li>Open your project and go to the Publishing tab.</li>
      <li>Enter your domain name in the Custom Domain field.</li>
      <li>Add a CNAME record at your DNS provider pointing your domain to <code>hosted.mustaflow.app</code>.</li>
      <li>Wait for DNS to propagate (usually a few minutes).</li>
      <li>NabuFlow automatically provisions an SSL certificate for your domain.</li>
    </ol>
  </section>
  <section aria-label="Authentication">
    <h2>Authentication</h2>
    <p>Use Personal Access Tokens (PATs) to authenticate API requests. Generate a token from Settings &rarr; API Tokens, then include it as a Bearer token in the Authorization header.</p>
  </section>
  <section aria-label="Domain API endpoints">
    <h2>Domain endpoints</h2>
    <p>The NabuFlow REST API lets you add, verify, and remove custom domains programmatically. All domain endpoints require a valid Personal Access Token.</p>
  </section>
  <section aria-label="Webhooks">
    <h2>Webhooks</h2>
    <p>Subscribe to build, publish, and deploy lifecycle events via webhooks. Register a webhook URL in your project settings to receive POST requests with event payloads.</p>
  </section>
  <nav aria-label="Related">
    <a href="/developers">Developer Portal</a>
    <a href="/help">Help Center</a>
  </nav>
</main>`,
  },
  {
    path: "/status",
    title: `System Status | ${SITE_NAME}`,
    description:
      "Live status and uptime for MustaFlow AI services — builder, preview, publishing, AI generation, and more.",
    body: `
<main>
  <section aria-label="Status header">
    <h1>MustaFlow Status</h1>
    <p>Live status and uptime for all MustaFlow AI services. This page is updated in real time.</p>
  </section>
  <section aria-label="Services monitored">
    <h2>Services</h2>
    <ul>
      <li>AI Builder — project builds and code generation</li>
      <li>Live Preview — project preview and iframe serving</li>
      <li>Publishing — app publish, promote, and deployment</li>
      <li>AI Generation — Ora AI assistant and image generation</li>
      <li>Database — project data storage</li>
      <li>Authentication — sign-in and account management</li>
      <li>Custom Domains — domain routing and SSL provisioning</li>
    </ul>
  </section>
</main>`,
  },
  {
    path: "/terms",
    title: `Terms of Service | ${SITE_NAME}`,
    description:
      "Read the MustaFlow AI Terms of Service. Learn about acceptable use, intellectual property, and your rights as a user.",
  },
  {
    path: "/privacy",
    title: `Privacy Policy | ${SITE_NAME}`,
    description:
      "Learn how MustaFlow AI collects, uses, and protects your data. We are committed to privacy and transparency.",
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
// When meta.jsonLd is set, a <script type="application/ld+json"> block is
// appended just before </head> so crawlers receive structured data in the
// initial HTML response — no JavaScript execution required.
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

  // Inject JSON-LD structured data before </head> so it is present in the
  // initial HTML response — visible to crawlers that do not execute JS.
  if (meta.jsonLd) {
    const scriptBlock = `    <script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`;
    html = html.replace("</head>", `${scriptBlock}\n  </head>`);
  }

  // Inject static body content into <div id="root"></div> so crawlers that
  // do not execute JavaScript see meaningful headings, copy, and links.
  // The React SPA replaces this via createRoot().render() in browsers.
  if (meta.body) {
    html = html.replace(
      /<div id="root"><\/div>/,
      `<div id="root"><div data-prerender-fallback>${meta.body.trim()}</div></div>`,
    );
  }

  return html;
}

function prerender(): void {
  // Use the full authenticated app entry (index.html) as the template for all
  // prerendered routes. This preserves Clerk, the full React SPA, and all
  // authenticated routes while still injecting SEO-friendly static body HTML
  // for crawlers. The lightweight public.html entry is only used by
  // prerender-dynamic-routes.ts for standalone public subpaths (/gallery/:slug,
  // /u/:username) that never need Clerk.
  // DO NOT use public.html here — it overwrites index.html with a bundle that
  // excludes Clerk, breaking all authenticated routes (Ora, billing, etc.).
  let indexHtmlPath = join(distDir, "index.html");
  let indexHtml: string;
  try {
    indexHtml = readFileSync(indexHtmlPath, "utf-8");
    console.log("[prerender] Using index.html as template (full authenticated app entry).");
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
