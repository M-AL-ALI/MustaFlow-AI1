import { useApp } from "./context/AppContext";
import { Sidebar } from "./components/Sidebar";
import { SignInScreen } from "./pages/SignInScreen";
import { SetupScreen } from "./pages/SetupScreen";
import { HomeScreen } from "./pages/HomeScreen";
import { PairingScreen } from "./pages/PairingScreen";
import { ProjectsScreen } from "./pages/ProjectsScreen";
import { SettingsScreen } from "./pages/SettingsScreen";

const pageComponents = {
  home: HomeScreen,
  pairing: PairingScreen,
  projects: ProjectsScreen,
  settings: SettingsScreen,
} as const;

export default function App() {
  const { session, hostState, isLoadingSession, currentPage } = useApp();

  if (isLoadingSession) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)" }}>
        Loading…
      </div>
    );
  }

  if (!session) return <SignInScreen />;
  if (!hostState || hostState.status === "unregistered") return <SetupScreen />;

  const PageContent = pageComponents[currentPage];

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <Sidebar />
      <main style={{ flex: 1, overflowY: "auto", padding: "28px 32px", background: "var(--bg-base)" }}>
        <PageContent />
      </main>
    </div>
  );
}
