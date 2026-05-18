import { HelpCircle, Zap, Lock, Globe, RefreshCw, MessageSquare, FileDown, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

const FAQS = [
  {
    q: "How do I build my first app?",
    a: "On the Home page, type a description of your app in the prompt box and click Start Building. The AI Builder will generate a static web app from your description. You can then refine it with follow-up messages in the chat.",
  },
  {
    q: "What kind of apps can I build?",
    a: "MustaFlow AI generates static web apps (HTML, CSS, and JavaScript with Tailwind and Lucide icons). You can build landing pages, dashboards, data visualizations, marketplaces, chatbot UIs, spreadsheet-style tools, and more.",
  },
  {
    q: "How do I add API keys or secrets?",
    a: "Inside your project workspace, go to Tools & Files → Secrets. Add your API keys there. Values are encrypted at rest and never returned by the API — only a masked preview is shown. Separate your test and production keys into the correct environments.",
  },
  {
    q: "How do I publish my app?",
    a: "Open the Publishing tab in your project workspace. Select the Testing or Production environment, complete the pre-publish checklist, and click Publish. Your app will be served from a public URL. Draft changes after publishing do not go live until you publish again.",
  },
  {
    q: "What is a public slug?",
    a: "When you publish your app, MustaFlow AI generates a unique readable URL slug (e.g. /api/p/my-app-a3f9kp/). This slug does not expose your internal project ID. It stays the same if you republish — so bookmarks and links remain valid.",
  },
  {
    q: "How do I roll back to a previous version?",
    a: "Go to Tools & Files → Versions. Each successful build or refine creates a snapshot. Click Roll Back next to any version to restore it. Rolling back does not affect your published site until you publish again.",
  },
  {
    q: "How do I export my project?",
    a: "In the project workspace, go to Manage → Export. You will download a ZIP file containing all generated files and a .env.example listing your secret names (without values).",
  },
  {
    q: "What is the Knowledge Vault?",
    a: "The Knowledge Vault stores learnings from your build sessions — patterns that worked, issues that were fixed, and rollback notes. Entries are scoped to your user and project and are never shared publicly unless you explicitly approve them.",
  },
  {
    q: "What encryption is used for secrets?",
    a: "Secrets are encrypted with AES-256-GCM using a per-deployment encryption key (ENCRYPTION_KEY). The key is stored securely and is required for the server to start in production. If the key is lost, existing secrets cannot be recovered — users must re-enter them.",
  },
  {
    q: "How do I contact support?",
    a: "Use the Contact Support link below. For urgent security issues, include 'SECURITY' in the subject line.",
  },
];

export default function HelpPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-12">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <HelpCircle className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Help & Documentation</h1>
        </div>
        <p className="text-muted-foreground text-sm">Everything you need to get started and build great apps with MustaFlow AI.</p>
      </div>

      <QuickLinks />

      <div className="space-y-4">
        <h2 className="font-semibold text-base">Frequently Asked Questions</h2>
        {FAQS.map((faq, i) => (
          <FaqItem key={i} q={faq.q} a={faq.a} />
        ))}
      </div>

      <div className="border border-border rounded-xl p-6 bg-card space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <h2 className="font-semibold">Still need help?</h2>
        </div>
        <p className="text-sm text-muted-foreground">Our support team is here to help. Describe your issue and we'll get back to you.</p>
        <a
          href="mailto:support@mustaflow.ai"
          className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          Contact Support
        </a>
      </div>
    </div>
  );
}

function QuickLinks() {
  const links = [
    { icon: Zap, label: "Quick Start", desc: "Build your first app in minutes", href: "/" },
    { icon: Lock, label: "Secret Security", desc: "How secrets are encrypted", href: "/privacy" },
    { icon: Globe, label: "Publishing Guide", desc: "Go live with your app", href: "#publishing" },
    { icon: RefreshCw, label: "Version History", desc: "Roll back to any snapshot", href: "#versions" },
    { icon: FileDown, label: "Export & Duplicate", desc: "Download or copy projects", href: "#export" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {links.map((l) => (
        <a
          key={l.label}
          href={l.href}
          className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card hover:bg-muted transition-colors"
        >
          <l.icon className="h-4 w-4 text-primary mt-0.5 shrink-0" />
          <div>
            <div className="text-sm font-medium">{l.label}</div>
            <div className="text-xs text-muted-foreground">{l.desc}</div>
          </div>
        </a>
      ))}
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-left hover:bg-muted transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{q}</span>
        {open ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed border-t border-border bg-card/50">
          <p className="pt-3">{a}</p>
        </div>
      )}
    </div>
  );
}
