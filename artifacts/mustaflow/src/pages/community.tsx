import { Link } from "wouter";
import {
  Users,
  Globe,
  Star,
  GitFork,
  ArrowRight,
  Layers,
  Share2,
} from "lucide-react";

export default function CommunityPage() {
  const highlights = [
    {
      title: "Template Gallery",
      description: "Browse 100s of community-built and official templates across every category.",
      href: "/gallery",
      icon: Layers,
      cta: "Browse templates",
    },
    {
      title: "Public Library",
      description: "Shared AI lessons and build knowledge from builders across the platform.",
      href: "/library",
      icon: Star,
      cta: "Explore lessons",
    },
    {
      title: "Your Profile",
      description: "Create a public profile to showcase your published projects and follow other builders.",
      href: "/settings",
      icon: Users,
      cta: "Set up profile",
    },
  ];

  const stats = [
    { label: "Templates published", value: "150+" },
    { label: "Community builders", value: "2,400+" },
    { label: "Projects created", value: "18,000+" },
    { label: "Knowledge lessons shared", value: "940+" },
  ];

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-10">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">Community</h1>
        <p className="text-sm text-muted-foreground">
          Build with others. Share your work. Learn from the best builders on the platform.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-card p-4 text-center">
            <p className="text-xl font-bold text-foreground">{stat.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Highlights */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {highlights.map((item) => (
          <Link key={item.href} href={item.href}>
            <div className="rounded-xl border border-border bg-card p-5 space-y-3 hover:border-primary/30 cursor-pointer transition-colors h-full">
              <item.icon className="h-6 w-6 text-primary" />
              <div>
                <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                <p className="text-xs text-muted-foreground mt-1">{item.description}</p>
              </div>
              <div className="flex items-center gap-1 text-xs text-primary font-medium">
                {item.cta}
                <ArrowRight className="h-3.5 w-3.5" />
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Built with MustaFlow badge */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Share2 className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Built with MustaFlow Badge</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Add the "Built with MustaFlow" badge to your published sites. Visitors can click it to
          discover your profile and other apps built on the platform.
        </p>
        <div className="flex items-center gap-3">
          <div className="rounded border border-primary/30 px-3 py-1 text-xs font-semibold text-primary bg-primary/10">
            Built with MustaFlow
          </div>
          <span className="text-xs text-muted-foreground">← Example badge (SVG coming soon)</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Go to{" "}
          <Link href="/settings">
            <span className="text-primary hover:underline cursor-pointer">Profile Settings</span>
          </Link>{" "}
          to create your public profile and get your personalized badge embed code.
        </p>
      </div>

      {/* How to get involved */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-foreground">How to get involved</h2>
        <div className="space-y-3">
          {[
            {
              icon: Layers,
              title: "Submit a template",
              description:
                "Open any project → Manage → Submit to Gallery. Templates go through a quick review then appear publicly.",
            },
            {
              icon: Star,
              title: "Rate and review templates",
              description:
                "Tried a community template? Leave a star rating to help other builders find the best starting points.",
            },
            {
              icon: GitFork,
              title: "Fork and remix",
              description:
                "See a template you like? Fork it into a new project, make it yours, and submit your version back.",
            },
            {
              icon: Globe,
              title: "Publish your projects",
              description:
                "Published projects can appear on your public profile and be showcased to the community.",
            },
          ].map((item) => (
            <div key={item.title} className="flex gap-3">
              <item.icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-foreground">{item.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
