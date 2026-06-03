import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState } from "react";
import { Palette } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

type BrandProfile = {
  primaryColor: string;
  accentColor: string;
  fontPairing: string;
  tone: string;
};

export function BrandPill() {
  const [profile, setProfile] = useState<BrandProfile | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/knowledge/brand-profile");
        if (!res.ok) return;
        const data = (await res.json()) as { profile: BrandProfile | null };
        if (cancelled) return;
        setProfile(data.profile);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded || !profile) return null;

  const summaryBits: string[] = [];
  if (profile.primaryColor) summaryBits.push(profile.primaryColor);
  if (profile.fontPairing) summaryBits.push(profile.fontPairing.split(",")[0] ?? "");
  if (profile.tone) summaryBits.push(profile.tone.split(" ")[0] ?? "");
  const summary = summaryBits.filter(Boolean).join(" · ");

  return (
    <Link
      href="/memory"
      className={cn(
        "shrink-0 flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium",
        "bg-purple-500/5 border-b border-purple-500/15 text-purple-300/90",
        "hover:bg-purple-500/10 hover:text-purple-200 transition-colors",
      )}
      title="Your saved brand profile is applied to every new build. Click to edit."
    >
      <Palette className="h-3 w-3 shrink-0 text-purple-400" />
      <span className="font-semibold text-purple-300">Your brand</span>
      {profile.primaryColor && (
        <span
          className="inline-block h-2.5 w-2.5 rounded-full border border-white/10"
          style={{ backgroundColor: profile.primaryColor }}
          aria-hidden
        />
      )}
      {profile.accentColor && (
        <span
          className="inline-block h-2.5 w-2.5 rounded-full border border-white/10 -ml-0.5"
          style={{ backgroundColor: profile.accentColor }}
          aria-hidden
        />
      )}
      <span className="truncate text-muted-foreground/80">{summary || "active"}</span>
      <span className="ml-auto text-[9px] text-muted-foreground/60">Edit</span>
    </Link>
  );
}
