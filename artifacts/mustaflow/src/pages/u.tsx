import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { PageMeta } from "@/components/page-meta";
import {
  Globe,
  Twitter,
  Github,
  MapPin,
  Users,
  Loader2,
  ExternalLink,
  Code2,
  ArrowLeft,
  CheckCircle2,
  Share2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface CommunityProfile {
  id: number;
  userId: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  websiteUrl: string | null;
  twitterHandle: string | null;
  githubHandle: string | null;
  location: string | null;
  showcasedProjectIds: number[];
  followerCount: number;
  followingCount: number;
  badgeEmbedEnabled: boolean;
  isFollowing: boolean;
  createdAt: string;
}

interface PublicProject {
  id: number;
  name: string;
  description: string | null;
  kind: string;
  platform: string;
  status: string;
  publicSlug: string | null;
  createdAt: string;
  updatedAt: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  web: "Web",
  cross: "Mobile",
  ios: "iOS",
  android: "Android",
};

function ProjectCard({ project }: { project: PublicProject }) {
  const [, navigate] = useLocation();
  const isPublished = project.status === "published" && project.publicSlug;

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 space-y-2",
        isPublished && "cursor-pointer hover:border-primary/30 transition-colors",
      )}
      onClick={() => isPublished && navigate(`/api/p/${project.publicSlug}/`)}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{project.name}</h3>
          {project.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {project.description}
            </p>
          )}
        </div>
        {isPublished && (
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
          {PLATFORM_LABELS[project.platform] ?? project.platform}
        </span>
        {isPublished && (
          <span className="text-[10px] text-green-500 font-medium flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Live
          </span>
        )}
      </div>
    </div>
  );
}

export default function UserProfilePage() {
  const { username } = useParams<{ username: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [profile, setProfile] = useState<CommunityProfile | null>(null);
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [followLoading, setFollowLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!username) return;

    const fetchProfile = async () => {
      setLoading(true);
      setNotFound(false);
      try {
        const [profileRes, projectsRes] = await Promise.all([
          authFetch(`/api/profiles/${username}`),
          authFetch(`/api/profiles/${username}/projects`),
        ]);

        if (profileRes.status === 404) {
          setNotFound(true);
          return;
        }

        if (!profileRes.ok) throw new Error("Failed to load profile");

        const profileData = (await profileRes.json()) as CommunityProfile;
        setProfile(profileData);

        if (projectsRes.ok) {
          const projectData = (await projectsRes.json()) as PublicProject[];
          setProjects(projectData);
        }
      } catch {
        toast({ title: "Failed to load profile", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    };

    void fetchProfile();
  }, [username, toast]);

  const handleFollow = async () => {
    if (!profile) return;
    setFollowLoading(true);
    try {
      const method = profile.isFollowing ? "DELETE" : "POST";
      const res = await authFetch(`/api/profiles/${username}/follow`, { method });
      if (res.status === 401) {
        toast({ title: "Sign in to follow users", variant: "destructive" });
        navigate("/sign-in");
        return;
      }
      if (!res.ok) throw new Error("Failed");

      setProfile((p) =>
        p
          ? {
              ...p,
              isFollowing: !p.isFollowing,
              followerCount: p.isFollowing ? p.followerCount - 1 : p.followerCount + 1,
            }
          : p,
      );
    } catch {
      toast({ title: "Failed to update follow status", variant: "destructive" });
    } finally {
      setFollowLoading(false);
    }
  };

  const handleCopyBadge = async () => {
    try {
      const res = await authFetch("/api/me/profile/badge");
      if (!res.ok) throw new Error("Get profile first");
      const { html } = (await res.json()) as { html: string };
      await navigator.clipboard.writeText(html);
      toast({ title: "Badge code copied to clipboard" });
    } catch {
      toast({ title: "Failed to copy badge — create your profile first", variant: "destructive" });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16 text-center space-y-4">
        <Users className="h-10 w-10 text-muted-foreground/30 mx-auto" />
        <h2 className="text-xl font-semibold text-foreground">Profile not found</h2>
        <p className="text-sm text-muted-foreground">
          The user <strong>@{username}</strong> hasn't created a public profile yet or doesn't
          exist.
        </p>
        <button
          onClick={() => window.history.back()}
          className="text-primary text-sm hover:underline flex items-center gap-1 mx-auto"
        >
          <ArrowLeft className="h-4 w-4" />
          Go back
        </button>
      </div>
    );
  }

  if (!profile) return null;

  const displayName = profile.displayName ?? profile.username;
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <PageMeta
        title={
          profile.displayName
            ? `${profile.displayName} (@${profile.username})`
            : `@${profile.username}`
        }
        description={
          profile.bio ??
          `See the public apps and projects built by ${profile.displayName ?? profile.username} on MustaFlow AI.`
        }
        path={`/u/${profile.username}`}
      />
      {/* Profile header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5 pb-6 border-b border-border">
        <div className="h-16 w-16 rounded-full overflow-hidden bg-muted border border-border shrink-0 flex items-center justify-center">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt={displayName} className="w-full h-full object-cover" />
          ) : (
            <span className="text-xl font-bold text-muted-foreground">{initials}</span>
          )}
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-foreground">{displayName}</h1>
            {profile.badgeEmbedEnabled && (
              <span className="text-xs text-primary border border-primary/30 px-2 py-0.5 rounded-full">
                Built with MustaFlow
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">@{profile.username}</p>

          {profile.bio && <p className="text-sm text-muted-foreground mt-2">{profile.bio}</p>}

          <div className="flex flex-wrap items-center gap-4 mt-3">
            {profile.location && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                {profile.location}
              </span>
            )}
            {profile.websiteUrl && (
              <a
                href={profile.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Globe className="h-3.5 w-3.5" />
                Website
              </a>
            )}
            {profile.twitterHandle && (
              <a
                href={`https://twitter.com/${profile.twitterHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Twitter className="h-3.5 w-3.5" />@{profile.twitterHandle}
              </a>
            )}
            {profile.githubHandle && (
              <a
                href={`https://github.com/${profile.githubHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Github className="h-3.5 w-3.5" />
                {profile.githubHandle}
              </a>
            )}
          </div>

          <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
            <span>
              <strong className="text-foreground">{profile.followerCount}</strong> followers
            </span>
            <span>
              <strong className="text-foreground">{profile.followingCount}</strong> following
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleFollow}
            disabled={followLoading}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-lg transition-colors",
              profile.isFollowing
                ? "border border-border text-muted-foreground hover:border-destructive hover:text-destructive"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {followLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : profile.isFollowing ? (
              "Unfollow"
            ) : (
              "Follow"
            )}
          </button>
          <button
            onClick={handleCopyBadge}
            className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            title="Copy 'Built with MustaFlow' badge"
          >
            <Share2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Projects section */}
      <div className="mt-8 space-y-4">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
            Projects
          </h2>
          <span className="text-xs text-muted-foreground">({projects.length})</span>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Code2 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No public projects yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>

      {/* "Built with MustaFlow" badge info */}
      <div className="mt-10 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Share2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Built with MustaFlow</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Add a badge to your published sites to show they were built with MustaFlow. Visitors can
          click it to discover more apps and builders.
        </p>
        <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-lg font-mono text-xs text-muted-foreground overflow-x-auto">
          <code>{`<a href="https://mustaflow.app/u/${profile.username}"><img src="https://mustaflow.app/badge/built-with-mustaflow.svg" alt="Built with MustaFlow" height="20" /></a>`}</code>
        </div>
        <button
          onClick={async () => {
            const code = `<a href="https://mustaflow.app/u/${profile.username}"><img src="https://mustaflow.app/badge/built-with-mustaflow.svg" alt="Built with MustaFlow" height="20" /></a>`;
            await navigator.clipboard.writeText(code);
            toast({ title: "Badge code copied" });
          }}
          className="mt-2 text-xs text-primary hover:underline"
        >
          Copy badge code
        </button>
      </div>
    </div>
  );
}
