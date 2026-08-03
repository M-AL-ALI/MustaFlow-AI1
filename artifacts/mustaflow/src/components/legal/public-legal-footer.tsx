import { Link } from "wouter";

const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/billing-refunds", label: "Billing & Refunds" },
  { href: "/acceptable-use", label: "Acceptable Use" },
] as const;

export function PublicLegalFooter() {
  return (
    <footer className="border-t border-border/80 bg-muted/20" data-testid="public-legal-footer">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <p>MustaFlow AI Technology LLC · North Carolina, USA</p>
        <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {LEGAL_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
          <a
            href="mailto:support@mustaflow.com"
            className="transition-colors hover:text-foreground"
          >
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
