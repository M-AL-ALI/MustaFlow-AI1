import type { ElementType, ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { PageMeta } from "@/components/page-meta";
import { PublicLegalFooter } from "./public-legal-footer";

interface LegalLayoutProps {
  title: string;
  description: string;
  path: string;
  icon: LucideIcon;
  introduction: ReactNode;
  children: ReactNode;
}

export function LegalLayout({
  title,
  description,
  path,
  icon: Icon,
  introduction,
  children,
}: LegalLayoutProps) {
  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <PageMeta title={title} description={description} path={path} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 sm:py-16">
        <header className="mb-10 space-y-5 border-b border-border pb-8">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon aria-hidden="true" className="h-5 w-5" />
            </span>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          </div>
          <div
            role="note"
            data-testid="legal-draft-notice"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-foreground"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="font-medium">Draft — effective date pending owner review.</span>
          </div>
          <div className="max-w-3xl space-y-3 text-base leading-7 text-muted-foreground">
            {introduction}
          </div>
        </header>
        <div className="space-y-10">{children}</div>
      </main>
      <PublicLegalFooter />
    </div>
  );
}

interface LegalSectionProps {
  number: number;
  title: string;
  icon?: ElementType;
  children: ReactNode;
}

export function LegalSection({ number, title, icon: Icon, children }: LegalSectionProps) {
  return (
    <section aria-labelledby={`legal-section-${number}`} className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-2 text-xs font-semibold text-foreground">
          {number}
        </span>
        {Icon ? <Icon aria-hidden="true" className="h-4 w-4 text-primary" /> : null}
        <h2 id={`legal-section-${number}`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
      </div>
      <div className="space-y-3 pl-10 text-sm leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

export function LegalContact({ subject }: { subject: string }) {
  return (
    <a
      href={`mailto:support@mustaflow.com?subject=${encodeURIComponent(subject)}`}
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      support@mustaflow.com
    </a>
  );
}
