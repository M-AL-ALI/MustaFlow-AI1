import { ChevronRight } from "lucide-react";
import { Link } from "wouter";

export type AdminBreadcrumbItem = {
  label: string;
  href?: string;
};

export function AdminBreadcrumbs({ items }: { items: readonly AdminBreadcrumbItem[] }) {
  return (
    <nav aria-label="Admin breadcrumbs" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="inline-flex items-center gap-1">
              {index > 0 && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
              {item.href && !current ? (
                <Link
                  href={item.href}
                  className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={current ? "page" : undefined}
                  className={current ? "text-foreground" : undefined}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
