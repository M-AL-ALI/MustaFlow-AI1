import { useId, useRef, useState, type FormEvent } from "react";
import { Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type ProjectDomainConnectFormProps = {
  value: string;
  onChange: (value: string) => void;
  onConnect: () => Promise<void>;
  isSubmitting: boolean;
  error: string | null;
};

/** Presentation and single-flight submission only; the parent retains the provider contract. */
export function ProjectDomainConnectForm({
  value,
  onChange,
  onConnect,
  isSubmitting,
  error,
}: ProjectDomainConnectFormProps) {
  const id = useId();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const busy = isSubmitting || pending;
  const visibleError = requestError ?? error;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || isSubmitting || !value.trim()) return;
    submitting.current = true;
    setPending(true);
    setRequestError(null);
    try {
      await onConnect();
    } catch {
      setRequestError("The domain connection could not be confirmed. Please try again.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form
      aria-label="Connect an existing domain"
      aria-busy={busy}
      onSubmit={handleSubmit}
      className="space-y-2"
    >
      <label htmlFor={id} className="text-sm font-medium">
        Domain you already own
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          name="hostname"
          value={value}
          onChange={(event) => {
            setRequestError(null);
            onChange(event.target.value);
          }}
          disabled={busy}
          aria-describedby={`${id}-help${visibleError ? ` ${id}-error` : ""}`}
          aria-invalid={Boolean(visibleError)}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          placeholder="app.yourdomain.com or yourdomain.com"
          className="min-w-0 flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy || !value.trim()}
          className="shrink-0"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Link2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          )}
          {busy ? "Connecting domain" : "Connect domain"}
        </Button>
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Enter a domain or subdomain. Connecting it does not transfer its registration.
      </p>
      {visibleError && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {visibleError}
        </p>
      )}
    </form>
  );
}
