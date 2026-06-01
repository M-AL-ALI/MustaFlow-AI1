import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { ArrowRight } from "lucide-react";
import { Show } from "@clerk/react";

export function PublicHeader() {
  const [, setLocation] = useLocation();

  return (
    <header className="sticky top-0 z-30 backdrop-blur-xl bg-background/80 border-b border-border">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <a
          href={import.meta.env.BASE_URL || "/"}
          className="flex items-center gap-2.5 group"
          aria-label="MustaFlow AI home"
        >
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt="MustaFlow AI"
            className="h-9 w-9 rounded-lg shadow-sm group-hover:scale-105 transition-transform"
          />
          <span className="text-lg font-bold tracking-tight hidden sm:inline">
            MustaFlow <span className="text-primary">AI</span>
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
          <button
            onClick={() => setLocation("/pricing")}
            className="hover:text-foreground transition-colors"
          >
            Pricing
          </button>
          <button
            onClick={() => setLocation("/integrations")}
            className="hover:text-foreground transition-colors"
          >
            Integrations
          </button>
          <button
            onClick={() => setLocation("/security")}
            className="hover:text-foreground transition-colors"
          >
            Security
          </button>
          <button
            onClick={() => setLocation("/developers")}
            className="hover:text-foreground transition-colors"
          >
            Developers
          </button>
          <button
            onClick={() => setLocation("/help")}
            className="hover:text-foreground transition-colors"
          >
            Help
          </button>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Show when="signed-out">
            <Button
              variant="ghost"
              size="sm"
              className="text-sm"
              onClick={() => setLocation("/sign-in")}
            >
              Log in
            </Button>
            <Button
              size="sm"
              className="rounded-full px-4 text-sm shadow-md"
              onClick={() => setLocation("/sign-up")}
            >
              Create account
            </Button>
          </Show>
          <Show when="signed-in">
            <Button
              size="sm"
              className="rounded-full px-4 text-sm"
              onClick={() => setLocation("/projects")}
            >
              My projects
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </Show>
        </div>
      </div>
    </header>
  );
}
