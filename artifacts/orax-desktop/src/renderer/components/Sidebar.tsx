import {
  Monitor,
  FolderOpen,
  Settings,
  HelpCircle,
  Unplug,
  LogOut,
  HeartPulse,
} from "lucide-react";
import { useApp, type Page } from "../context/AppContext";

const NAV_ITEMS: { page: Page; label: string; icon: React.FC<{ size: number }> }[] = [
  { page: "home", label: "Status", icon: Monitor },
  { page: "health", label: "Health", icon: HeartPulse },
  { page: "pairing", label: "Pairing", icon: Unplug },
  { page: "projects", label: "Projects", icon: FolderOpen },
  { page: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const { session, hostState, currentPage, setPage, signOut } = useApp();

  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "20px 16px 12px", borderBottom: "1px solid var(--border)" }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: 16,
            color: "var(--text-primary)",
            letterSpacing: "-0.02em",
          }}
        >
          Orax Desktop
        </div>
        {hostState && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <span className={`status-dot ${hostState.status}`} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {hostState.status === "online"
                ? "Online"
                : hostState.status === "reconnecting"
                  ? "Reconnecting…"
                  : "Offline"}
            </span>
          </div>
        )}
      </div>

      {session && (
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {session.displayName}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {session.email}
          </div>
        </div>
      )}

      <nav style={{ flex: 1, padding: "8px 8px", overflowY: "auto" }}>
        {NAV_ITEMS.map(({ page, label, icon: Icon }) => (
          <button
            key={page}
            onClick={() => setPage(page)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              background: currentPage === page ? "var(--accent-dim)" : "transparent",
              color: currentPage === page ? "var(--accent)" : "var(--text-secondary)",
              fontWeight: currentPage === page ? 600 : 400,
              fontSize: 13,
              marginBottom: 2,
              cursor: "pointer",
              border: "none",
              textAlign: "left",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>

      <div style={{ padding: "8px 8px 12px", borderTop: "1px solid var(--border)" }}>
        <a
          href="https://www.mustaflow.com/help?mode=report"
          target="_blank"
          rel="noreferrer"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--text-secondary)",
            fontSize: 13,
            cursor: "pointer",
            border: "none",
            textAlign: "left",
            marginBottom: 2,
            textDecoration: "none",
          }}
        >
          <HelpCircle size={15} />
          Help &amp; Support
        </a>
        <button
          onClick={() => void signOut()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--text-muted)",
            fontSize: 13,
            cursor: "pointer",
            border: "none",
            textAlign: "left",
          }}
        >
          <LogOut size={15} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
