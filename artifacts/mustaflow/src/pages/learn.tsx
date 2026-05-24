import { Link } from "wouter";
import {
  GraduationCap,
  Sparkles,
  Wand2,
  Rocket,
  Globe,
  ShieldCheck,
  CreditCard,
  Layers,
  BookOpen,
  PlayCircle,
  ArrowRight,
  Lightbulb,
} from "lucide-react";

interface Lesson {
  title: string;
  description: string;
  icon: typeof Sparkles;
  minutes: number;
  href?: string;
}

const STARTER_LESSONS: Lesson[] = [
  {
    title: "Describe your first app",
    description:
      "Open the builder, write what you want in plain words, and let the AI plan it before it builds.",
    icon: Sparkles,
    minutes: 3,
    href: "/projects",
  },
  {
    title: "Refine with the chat",
    description:
      "Ask for changes one step at a time. Each refine is saved as a version you can roll back.",
    icon: Wand2,
    minutes: 4,
  },
  {
    title: "Preview and publish",
    description:
      "Test your app in the preview tab, then publish a snapshot to share a link with anyone.",
    icon: Rocket,
    minutes: 3,
  },
  {
    title: "Connect a custom domain",
    description:
      "Add your own domain in the Publishing tab and follow the DNS steps to go live.",
    icon: Globe,
    minutes: 5,
  },
];

const DEEP_DIVES: Lesson[] = [
  {
    title: "Plan mode vs Build mode",
    description:
      "When to let the AI think first with a structured plan, and when to ship a quick edit.",
    icon: Lightbulb,
    minutes: 4,
  },
  {
    title: "Lite, Eco, Power, Pro",
    description:
      "Pick the right agent mode for the job. Lite is fast and cheap; Pro is slower and smarter.",
    icon: Layers,
    minutes: 3,
  },
  {
    title: "Security Center",
    description:
      "Read findings across your projects, dismiss false positives, and run a scan on demand.",
    icon: ShieldCheck,
    minutes: 4,
    href: "/security",
  },
  {
    title: "Credits and billing",
    description:
      "Understand how each build, refine, and scan spends credits, and how to top up.",
    icon: CreditCard,
    minutes: 3,
    href: "/billing",
  },
];

function LessonCard({ lesson }: { lesson: Lesson }) {
  const Icon = lesson.icon;
  const inner = (
    <div className="group rounded-xl border border-border bg-card p-5 hover:border-primary/40 hover:bg-card/80 transition-colors h-full flex flex-col">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 text-primary p-2 shrink-0">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{lesson.title}</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {lesson.description}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <PlayCircle className="h-3 w-3" />
          {lesson.minutes} min read
        </span>
        {lesson.href && (
          <span className="inline-flex items-center gap-1 text-primary group-hover:translate-x-0.5 transition-transform">
            Open <ArrowRight className="h-3 w-3" />
          </span>
        )}
      </div>
    </div>
  );

  if (lesson.href) {
    return (
      <Link href={lesson.href} className="block h-full">
        {inner}
      </Link>
    );
  }
  return inner;
}

export default function LearnPage() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <header className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 text-primary p-2">
            <GraduationCap className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Learn</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Short, plain-language guides to get the most out of MustaFlow. No code required.
            </p>
          </div>
        </header>

        <section className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-6">
          <div className="flex items-start gap-4 flex-wrap">
            <div className="flex-1 min-w-[260px]">
              <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                New here? Start with the basics.
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Four short lessons take you from a blank page to a published app you can share.
              </p>
            </div>
            <Link
              href="/projects"
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Build my first app <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            Getting started
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {STARTER_LESSONS.map((l) => (
              <LessonCard key={l.title} lesson={l} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Going deeper
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {DEEP_DIVES.map((l) => (
              <LessonCard key={l.title} lesson={l} />
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">Need a real person?</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Browse the community for examples and questions, or check the gallery for templates you
            can remix in one click.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/community"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/60 transition-colors"
            >
              Community <ArrowRight className="h-3 w-3" />
            </Link>
            <Link
              href="/gallery"
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/60 transition-colors"
            >
              Template gallery <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
