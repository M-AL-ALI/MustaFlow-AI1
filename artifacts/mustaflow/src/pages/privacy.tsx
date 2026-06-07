import { Shield, Eye, Database, Bell } from "lucide-react";
import { PageMeta } from "@/components/page-meta";

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">
      <PageMeta
        title="Privacy Policy"
        description="Learn how MustaFlow AI collects, uses, and protects your data. We are committed to privacy and transparency."
        path="/privacy"
        noIndex={true}
      />
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Privacy Policy</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Last updated: May 2026 — Placeholder document. Final version will be reviewed before
          public launch.
        </p>
      </div>

      <Section icon={Eye} title="1. Information We Collect">
        <p>We collect information you provide directly, including:</p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>Account information (name, email) provided during sign-up via Clerk.</li>
          <li>Project data: names, descriptions, generated files, and version history.</li>
          <li>API key names (but never API key values — these are encrypted at rest).</li>
          <li>Chat messages you send to the AI Builder.</li>
          <li>Usage data: build counts, publish events, and Knowledge Vault entries.</li>
        </ul>
      </Section>

      <Section icon={Shield} title="2. How We Protect Your Data">
        <p>
          API secrets stored in MustaFlow AI are encrypted at rest using AES-256-GCM. The raw values
          are never returned by the API — only masked previews (e.g.,{" "}
          <code className="font-mono text-xs bg-muted px-1 rounded">••••••••XXXX</code>) are shown
          in the UI.
        </p>
        <p className="mt-2">Authentication is handled by Clerk. We do not store passwords.</p>
      </Section>

      <Section icon={Database} title="3. How We Use Your Data">
        <ul className="list-disc pl-5 space-y-1">
          <li>To generate, build, and serve your apps.</li>
          <li>To power the Knowledge Vault and improve build quality across sessions.</li>
          <li>To provide version history and rollback functionality.</li>
          <li>We do not sell your data to third parties.</li>
        </ul>
      </Section>

      <Section icon={Bell} title="4. Third-Party Services">
        <p>We use the following third-party services:</p>
        <ul className="list-disc pl-5 space-y-1 mt-2">
          <li>
            <strong>Clerk</strong> — authentication and user management.
          </li>
          <li>
            <strong>OpenAI</strong> — AI code generation (your prompts and project context are sent
            to OpenAI's API).
          </li>
          <li>
            <strong>PostgreSQL</strong> — database storage (hosted by Replit).
          </li>
        </ul>
      </Section>

      <Section icon={Shield} title="5. Data Retention">
        <p>
          Project data is retained until you delete your project or account. Soft-deleted projects
          are retained server-side for recovery purposes. Contact support to request hard deletion.
        </p>
      </Section>

      <Section icon={Shield} title="6. Your Rights">
        <p>
          You have the right to access, export, or delete your data. Use the Export (ZIP) feature in
          your project to download your generated files at any time. To request account deletion,
          contact support.
        </p>
      </Section>

      <div className="border-t border-border pt-6 text-sm text-muted-foreground">
        Privacy questions?{" "}
        <a href="/help" className="text-primary hover:underline">
          Contact Support
        </a>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary shrink-0" />
        <h2 className="font-semibold text-base">{title}</h2>
      </div>
      <div className="text-sm text-muted-foreground leading-relaxed pl-6 space-y-2">{children}</div>
    </div>
  );
}
