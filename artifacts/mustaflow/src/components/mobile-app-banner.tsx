import { useState } from "react";
import { X, Smartphone } from "lucide-react";
import { useSearch } from "wouter";

export function MobileAppBanner() {
  const searchString = useSearch();
  const source = new URLSearchParams(searchString).get("source");
  const [dismissed, setDismissed] = useState(false);

  if (source !== "mobile" || dismissed) return null;

  return (
    <div
      data-testid="mobile-app-banner"
      className="flex items-center justify-between gap-3 bg-primary/10 border-b border-primary/20 px-4 py-2.5 text-sm"
    >
      <div className="flex items-center gap-2 text-primary font-medium">
        <Smartphone className="h-4 w-4 shrink-0" />
        <span>Opened from the Ora app — tap Done when finished</span>
      </div>
      <button
        type="button"
        aria-label="Dismiss banner"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-primary/60 hover:text-primary transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
