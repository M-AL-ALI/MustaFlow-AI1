import { BarChart3, TrendingUp, Users, Clock } from "lucide-react";

export function AnalyticsTab() {
  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h2 className="text-xl font-bold mb-1">Analytics</h2>
          <p className="text-sm text-muted-foreground">Usage metrics and performance data for this project.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Page Views", value: "—", icon: BarChart3, note: "Not yet deployed" },
            { label: "Unique Visitors", value: "—", icon: Users, note: "Not yet deployed" },
            { label: "Avg Session", value: "—", icon: Clock, note: "Not yet deployed" },
            { label: "Growth", value: "—", icon: TrendingUp, note: "Not yet deployed" },
          ].map((stat) => (
            <div key={stat.label} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2 text-muted-foreground">
                <stat.icon className="h-4 w-4" />
                <span className="text-xs font-medium">{stat.label}</span>
              </div>
              <div className="text-2xl font-bold text-muted-foreground">{stat.value}</div>
              <div className="text-[11px] text-muted-foreground/60 mt-1">{stat.note}</div>
            </div>
          ))}
        </div>
        <div className="bg-card border border-border rounded-xl p-8 text-center text-muted-foreground">
          <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Analytics will appear here once your app is published and receiving traffic.</p>
        </div>
      </div>
    </div>
  );
}
