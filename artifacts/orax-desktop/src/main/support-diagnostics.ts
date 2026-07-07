import { app } from "electron";
import type {
  AuthSession,
  HostState,
  LocalProject,
  RelayState,
  SupportDiagnostics,
} from "../shared/types";

interface BuildSupportDiagnosticsParams {
  session: AuthSession | null;
  hostState: HostState | null;
  relayState: RelayState;
  localProjects: LocalProject[];
}

export function buildSupportDiagnostics({
  session,
  hostState,
  relayState,
  localProjects,
}: BuildSupportDiagnosticsParams): SupportDiagnostics {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: "Orax Desktop",
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
    },
    auth: {
      signedIn: Boolean(session),
      userId: session?.userId ?? null,
      email: session?.email ?? null,
    },
    host: hostState ? { ...hostState } : null,
    relay: { ...relayState },
    localProjects: {
      count: localProjects.length,
      displayNames: localProjects.map((project) => project.displayName),
    },
    safety: {
      includesSessionToken: false,
      includesPasswords: false,
      includesEnvironmentVariables: false,
      includesLocalProjectPaths: false,
    },
  };
}
