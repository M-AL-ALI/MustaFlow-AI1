import { BookOpen, Code2, Video, FileText, ExternalLink } from "lucide-react";

const RESOURCES = [
  {
    category: "Getting Started",
    items: [
      { title: "How the AI Builder works", icon: Code2, desc: "Learn how MustaFlow generates and modifies your app." },
      { title: "Plan Mode vs. Build Mode", icon: FileText, desc: "When to plan first and when to build directly." },
      { title: "Understanding agent modes", icon: BookOpen, desc: "Lite, Eco, Power, and Pro — what's the difference?" },
    ],
  },
  {
    category: "Advanced",
    items: [
      { title: "Adding integrations", icon: Code2, desc: "Connect Stripe, Auth, Maps, and more to your app." },
      { title: "Managing secrets", icon: FileText, desc: "How to add and use environment variables." },
      { title: "Version history & rollback", icon: BookOpen, desc: "Restore any previous version of your project." },
    ],
  },
];

export function ResourcesTab() {
  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-bold mb-1">Resources</h2>
          <p className="text-sm text-muted-foreground">Guides and documentation to help you build faster.</p>
        </div>
        {RESOURCES.map((section) => (
          <div key={section.category}>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">{section.category}</h3>
            <div className="space-y-2">
              {section.items.map((item) => (
                <div
                  key={item.title}
                  className="flex items-center gap-4 p-4 bg-card border border-border rounded-xl hover:border-primary/30 cursor-pointer transition-colors group"
                >
                  <div className="bg-primary/10 p-2 rounded-lg">
                    <item.icon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{item.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{item.desc}</div>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
