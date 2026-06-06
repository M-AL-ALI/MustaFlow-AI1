/**
 * Task #1312 — initial Help Center content.
 *
 * Powers both the public Help Center page and Ora Support Mode retrieval.
 * Original branding only; no emojis. Keep bodies concise and factual.
 */
export interface HelpArticleSeed {
  slug: string;
  category: string;
  title: string;
  body: string;
  tags: string[];
  isFaq: boolean;
  sortOrder: number;
}

export const HELP_ARTICLE_SEED: HelpArticleSeed[] = [
  {
    slug: "getting-started-first-app",
    category: "getting-started",
    title: "Building your first app",
    body: "Create an account, then describe the app you want in plain language on the New Project screen. The AI Builder plans the app, generates the files, and shows a live preview. You can keep refining by sending follow-up instructions in the Builder chat. When you are happy with the result, publish it to a testing URL and then promote it to production.",
    tags: ["start", "build", "new project", "first app", "create"],
    isFaq: false,
    sortOrder: 1,
  },
  {
    slug: "getting-started-modes",
    category: "getting-started",
    title: "Choosing a build mode",
    body: "The Builder offers Lite, Eco, Power, and Pro modes. Lite and Eco are faster and cheaper for small changes; Power and Pro use a stronger model for complex builds and refactors. Each mode has a different credit cost per task. Pick a lighter mode for quick edits and a heavier mode for ambitious features.",
    tags: ["mode", "lite", "eco", "power", "pro", "credits"],
    isFaq: false,
    sortOrder: 2,
  },
  {
    slug: "builder-preview-not-loading",
    category: "troubleshooting",
    title: "My preview is blank or not loading",
    body: "A blank preview usually means the latest build had an error or has not finished. Open the Logs tab to check for build errors, then try sending the Builder a message describing what is broken so it can repair the app. If the preview still does not load, use the Activity tab to confirm the most recent build succeeded, or roll back to a previous working version from the Versions list.",
    tags: ["preview", "blank", "not loading", "broken", "error", "build"],
    isFaq: false,
    sortOrder: 1,
  },
  {
    slug: "builder-rollback",
    category: "builder",
    title: "Rolling back to a previous version",
    body: "Every successful build or refine saves a snapshot of all your files. Open the project, go to the version history, and choose Roll back on the version you want to restore. Rolling back replaces the current files with that snapshot; your other versions are kept so you can move forward again.",
    tags: ["rollback", "version", "restore", "undo", "history"],
    isFaq: false,
    sortOrder: 1,
  },
  {
    slug: "publishing-testing-production",
    category: "publishing",
    title: "Publishing: testing vs production",
    body: "Publishing freezes a snapshot of your app and serves it at a public URL. Full-stack apps must pass a testing step before they can go to production. Static apps can publish directly. Draft edits stay private until you publish again. You can also connect a custom domain from the Publishing tab and follow the DNS instructions shown there.",
    tags: ["publish", "deploy", "testing", "production", "domain", "go live"],
    isFaq: false,
    sortOrder: 1,
  },
  {
    slug: "billing-credits",
    category: "billing",
    title: "How credits work",
    body: "New accounts start with a credit balance. Each Builder task costs credits based on the mode used: Lite costs the least and Pro costs the most. A task runs a pre-flight check and will not start if your balance is too low. Image generation and some tools draw on separate daily allowances depending on your plan.",
    tags: ["credits", "billing", "cost", "balance", "pricing", "payment"],
    isFaq: false,
    sortOrder: 1,
  },
  {
    slug: "account-data-export",
    category: "account",
    title: "Exporting or deleting your data",
    body: "From Settings, open the Privacy & Data tab. You can download a full export of your projects, generated files, and chat history as a ZIP. Secret values are never included in the export. The same tab has an account data deletion option that soft-deletes all of your projects.",
    tags: ["export", "delete", "gdpr", "privacy", "data", "account"],
    isFaq: false,
    sortOrder: 1,
  },
  {
    slug: "account-secrets",
    category: "account",
    title: "Adding secrets and environment variables",
    body: "Open the Secrets tab inside a project to add API keys and environment variables. Secret values are encrypted at rest and never returned by the app — only a masked preview is shown. For secrets that should be available in the live preview, toggle Preview safe on that secret.",
    tags: ["secrets", "environment", "api key", "env", "variables"],
    isFaq: false,
    sortOrder: 2,
  },
  {
    slug: "faq-what-is-mustaflow",
    category: "faq",
    title: "What is MustaFlow?",
    body: "MustaFlow is an AI-powered app builder for non-technical users. You describe an app idea in natural language and MustaFlow plans, builds, previews, and helps you publish it. It supports static web apps, React apps, full-stack Node.js apps, and native mobile apps.",
    tags: ["what is", "about", "mustaflow", "overview"],
    isFaq: true,
    sortOrder: 1,
  },
  {
    slug: "faq-do-i-need-to-code",
    category: "faq",
    title: "Do I need to know how to code?",
    body: "No. You describe what you want in plain language and the AI Builder writes the code for you. You can review and refine the result through chat without editing code yourself, though the files are available if you want them.",
    tags: ["code", "coding", "technical", "beginner", "no code"],
    isFaq: true,
    sortOrder: 2,
  },
  {
    slug: "faq-build-mobile-apps",
    category: "faq",
    title: "Can I build mobile apps?",
    body: "Yes. When your prompt describes a mobile app, MustaFlow automatically uses its mobile pipeline to generate a native Expo / React Native app. You do not need to change any setting; the stack is detected from your description.",
    tags: ["mobile", "ios", "android", "expo", "native app"],
    isFaq: true,
    sortOrder: 3,
  },
  {
    slug: "faq-contact-support",
    category: "faq",
    title: "How do I contact support?",
    body: "Use Ask Ora in the Help Center for instant help. Ora can troubleshoot most issues using these help articles and your account details. If Ora cannot resolve your problem, use Escalate to support to open a ticket that is sent to our support team with your conversation and any screenshots you attach.",
    tags: ["support", "contact", "help", "escalate", "ticket"],
    isFaq: true,
    sortOrder: 4,
  },
];
