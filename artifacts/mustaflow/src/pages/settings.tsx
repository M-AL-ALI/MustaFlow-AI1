import { useState, useEffect } from "react";
import { useUser } from "@clerk/react";
import { Sun, Moon, Monitor, Save, User, Bell } from "lucide-react";
import { applyTheme, getStoredTheme, type AppearanceMode } from "@/lib/theme";

interface UserPrefs {
  emailBuildComplete?: boolean;
  emailWeeklyDigest?: boolean;
  appearance?: AppearanceMode;
}

export default function SettingsPage() {
  const { user, isLoaded } = useUser();

  const [displayName, setDisplayName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [emailBuildComplete, setEmailBuildComplete] = useState(false);
  const [emailWeeklyDigest, setEmailWeeklyDigest] = useState(false);
  const [savingNotifs, setSavingNotifs] = useState(false);
  const [notifsSaved, setNotifsSaved] = useState(false);
  const [notifsError, setNotifsError] = useState<string | null>(null);

  const [appearance, setAppearance] = useState<AppearanceMode>(getStoredTheme());

  useEffect(() => {
    if (!isLoaded || !user) return;

    const full = [user.firstName ?? "", user.lastName ?? ""].join(" ").trim();
    setDisplayName(full || user.username || "");

    const prefs = (user.unsafeMetadata ?? {}) as UserPrefs;
    if (prefs.emailBuildComplete !== undefined) setEmailBuildComplete(prefs.emailBuildComplete);
    if (prefs.emailWeeklyDigest !== undefined) setEmailWeeklyDigest(prefs.emailWeeklyDigest);
    if (prefs.appearance) {
      setAppearance(prefs.appearance);
      applyTheme(prefs.appearance);
    }
  }, [isLoaded, user]);

  const saveProfile = async () => {
    if (!user) return;
    setSavingProfile(true);
    setProfileError(null);
    try {
      const parts = displayName.trim().split(/\s+/);
      const firstName = parts[0] ?? "";
      const lastName = parts.slice(1).join(" ");
      await user.update({ firstName, lastName });
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Failed to save profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const saveNotifications = async () => {
    if (!user) return;
    setSavingNotifs(true);
    setNotifsError(null);
    try {
      const existing = (user.unsafeMetadata ?? {}) as UserPrefs;
      await user.update({
        unsafeMetadata: {
          ...existing,
          emailBuildComplete,
          emailWeeklyDigest,
        },
      });
      setNotifsSaved(true);
      setTimeout(() => setNotifsSaved(false), 2500);
    } catch (e) {
      setNotifsError(e instanceof Error ? e.message : "Failed to save preferences");
    } finally {
      setSavingNotifs(false);
    }
  };

  const handleAppearanceChange = async (mode: AppearanceMode) => {
    setAppearance(mode);
    applyTheme(mode);
    if (user) {
      try {
        const existing = (user.unsafeMetadata ?? {}) as UserPrefs;
        await user.update({ unsafeMetadata: { ...existing, appearance: mode } });
      } catch {
        // best-effort; applyTheme already updated localStorage as fallback
      }
    }
  };

  if (!isLoaded) {
    return (
      <div className="p-8 max-w-4xl mx-auto w-full">
        <div className="h-8 w-40 bg-muted rounded animate-pulse mb-8" />
        <div className="space-y-4">
          <div className="h-32 bg-muted rounded-lg animate-pulse" />
          <div className="h-32 bg-muted rounded-lg animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-3xl font-bold tracking-tight mb-8">Settings</h1>
      <div className="space-y-6">

        <div className="border border-border rounded-lg p-6 bg-card space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <User className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Account</h2>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-muted-foreground">Email</label>
            <div className="px-3 py-2 rounded-md border border-border bg-muted/40 text-sm text-muted-foreground select-none">
              {user?.primaryEmailAddress?.emailAddress ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground">Email is managed through your sign-in provider.</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="display-name" className="text-sm font-medium">Display Name</label>
            <input
              id="display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Your name"
            />
          </div>

          {profileError && (
            <p className="text-sm text-destructive">{profileError}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={() => void saveProfile()}
              disabled={savingProfile || !displayName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Save className="h-3.5 w-3.5" />
              {savingProfile ? "Saving…" : "Save Profile"}
            </button>
            {profileSaved && (
              <span className="text-sm text-green-500">Saved</span>
            )}
          </div>
        </div>

        <div className="border border-border rounded-lg p-6 bg-card space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Email Notifications</h2>
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={emailBuildComplete}
                onChange={(e) => setEmailBuildComplete(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <div>
                <div className="text-sm font-medium">Build complete</div>
                <div className="text-xs text-muted-foreground">Notify me when a build or refine finishes</div>
              </div>
            </label>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={emailWeeklyDigest}
                onChange={(e) => setEmailWeeklyDigest(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <div>
                <div className="text-sm font-medium">Weekly digest</div>
                <div className="text-xs text-muted-foreground">A weekly summary of your project activity</div>
              </div>
            </label>
          </div>

          {notifsError && (
            <p className="text-sm text-destructive">{notifsError}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={() => void saveNotifications()}
              disabled={savingNotifs}
              className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Save className="h-3.5 w-3.5" />
              {savingNotifs ? "Saving…" : "Save Preferences"}
            </button>
            {notifsSaved && (
              <span className="text-sm text-green-500">Saved</span>
            )}
          </div>
        </div>

        <div className="border border-border rounded-lg p-6 bg-card space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Appearance</h2>
          </div>
          <p className="text-sm text-muted-foreground">Choose how MustaFlow AI looks to you.</p>
          <div className="flex gap-3">
            <AppearanceOption
              mode="dark"
              label="Dark"
              icon={Moon}
              selected={appearance === "dark"}
              onSelect={(m) => void handleAppearanceChange(m)}
            />
            <AppearanceOption
              mode="light"
              label="Light"
              icon={Sun}
              selected={appearance === "light"}
              onSelect={(m) => void handleAppearanceChange(m)}
            />
            <AppearanceOption
              mode="system"
              label="System"
              icon={Monitor}
              selected={appearance === "system"}
              onSelect={(m) => void handleAppearanceChange(m)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceOption({
  mode,
  label,
  icon: Icon,
  selected,
  onSelect,
}: {
  mode: AppearanceMode;
  label: string;
  icon: React.ElementType;
  selected: boolean;
  onSelect: (m: AppearanceMode) => void;
}) {
  return (
    <button
      onClick={() => onSelect(mode)}
      className={`flex flex-col items-center gap-2 px-5 py-4 rounded-lg border text-sm font-medium transition-colors ${
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:border-muted-foreground/50"
      }`}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}
