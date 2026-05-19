import { useState, useCallback, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  FolderTree,
  FileCode2,
  TerminalSquare,
  Lock,
  Blocks,
  Save,
  History as HistoryIcon,
  Info,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Puzzle,
  ToggleLeft,
  ToggleRight,
  KeyRound,
  Package,
} from "lucide-react";
import { IntegrationsRegistry } from "./integrations-registry";
import { VersionTimeline } from "./version-timeline";
import {
  useListSecrets,
  useCreateSecret,
  getListSecretsQueryKey,
  useListProjectFiles,
  getListProjectFilesQueryKey,
  useGetProjectFile,
  getGetProjectFileQueryKey,
  useListVersions,
  getListVersionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const MOBILE_MODULES = [
  {
    id: "auth",
    name: "Authentication",
    provider: "Clerk",
    description: "User sign-in, sign-up, and session management.",
    requiredSecrets: ["CLERK_PUBLISHABLE_KEY"],
    packageDependencies: ["@clerk/clerk-expo", "expo-secure-store"],
  },
  {
    id: "payments",
    name: "In-App Purchases",
    provider: "RevenueCat",
    description: "Subscription paywalls, purchase flows, and entitlement checks.",
    requiredSecrets: ["REVENUECAT_API_KEY"],
    packageDependencies: ["@revenuecat/purchases-react-native"],
  },
  {
    id: "push",
    name: "Push Notifications",
    provider: "Expo Notifications",
    description: "FCM and APNS push notifications with registration flow.",
    requiredSecrets: [],
    packageDependencies: ["expo-notifications", "expo-device"],
  },
  {
    id: "realtime-db",
    name: "Real-time Database",
    provider: "Supabase",
    description: "Typed queries, real-time subscriptions, and Row Level Security.",
    requiredSecrets: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    packageDependencies: ["@supabase/supabase-js"],
  },
  {
    id: "analytics",
    name: "Analytics",
    provider: "Amplitude",
    description: "Event tracking wired to key user actions.",
    requiredSecrets: ["AMPLITUDE_API_KEY"],
    packageDependencies: ["@amplitude/analytics-react-native"],
  },
  {
    id: "deep-links",
    name: "Deep Links",
    provider: "Expo Linking",
    description: "Share links, invites, and referral flows.",
    requiredSecrets: [],
    packageDependencies: ["expo-linking"],
  },
  {
    id: "offline",
    name: "Offline Support",
    provider: "AsyncStorage + SQLite",
    description: "Local caching and SQLite for offline-first apps.",
    requiredSecrets: [],
    packageDependencies: ["@react-native-async-storage/async-storage", "expo-sqlite"],
  },
  {
    id: "camera-media",
    name: "Camera & Media",
    provider: "Expo Camera",
    description: "Camera capture, photo/video picking, and media upload.",
    requiredSecrets: [],
    packageDependencies: ["expo-camera", "expo-image-picker"],
  },
];

function SecretVerifyButton({
  secretId,
  projectId,
  initialStatus,
}: {
  secretId: number;
  projectId: number;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus ?? "unverified");
  const [loading, setLoading] = useState(false);

  const verify = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets/${secretId}/verify`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as { status: string };
        setStatus(data.status);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [projectId, secretId]);

  const icon =
    status === "verified" ? (
      <CheckCircle2 className="h-3 w-3 text-green-500" />
    ) : status === "verification_failed" ? (
      <XCircle className="h-3 w-3 text-destructive" />
    ) : (
      <AlertCircle className="h-3 w-3 text-muted-foreground" />
    );

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {icon}
      <button
        onClick={() => void verify()}
        disabled={loading}
        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 whitespace-nowrap"
      >
        {loading ? "Checking…" : "Verify"}
      </button>
    </div>
  );
}

function ModuleLibrary({
  projectId,
  secrets,
  wiredModuleIds,
  onSendMessage,
}: {
  projectId: number;
  secrets: Array<{ name: string; id: number }>;
  wiredModuleIds?: string[];
  onSendMessage?: (text: string) => void;
}) {
  const secretNames = new Set(secrets.map((s) => s.name));
  const [activeModules, setActiveModules] = useState<Set<string>>(
    () => new Set(wiredModuleIds ?? []),
  );

  // Sync when parent derives wired modules from a newly completed task report
  useEffect(() => {
    if (wiredModuleIds) {
      setActiveModules(new Set(wiredModuleIds));
    }
  }, [wiredModuleIds?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [addSecretFor, setAddSecretFor] = useState<string | null>(null);
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const createSecret = useCreateSecret();
  const queryClient = useQueryClient();

  const getModuleStatus = (mod: typeof MOBILE_MODULES[0]): "active" | "inactive" | "needs-secret" => {
    if (!activeModules.has(mod.id)) {
      if (mod.requiredSecrets.length > 0 && !mod.requiredSecrets.every((s) => secretNames.has(s))) {
        return "needs-secret";
      }
      return "inactive";
    }
    return "active";
  };

  const handleToggle = (mod: typeof MOBILE_MODULES[0]) => {
    const status = getModuleStatus(mod);

    if (status === "needs-secret") {
      setAddSecretFor(mod.id);
      setNewSecretName(mod.requiredSecrets.find((s) => !secretNames.has(s)) ?? "");
      return;
    }

    if (status === "active") {
      setActiveModules((prev) => {
        const next = new Set(prev);
        next.delete(mod.id);
        return next;
      });
      if (onSendMessage) {
        onSendMessage(`Remove the ${mod.name} (${mod.provider}) integration cleanly. Remove all related imports, initialization code, and screens added for this module.`);
      }
    } else {
      setActiveModules((prev) => new Set([...prev, mod.id]));
      const secretsList = mod.requiredSecrets.length > 0
        ? ` using the API key stored in ${mod.requiredSecrets.join(", ")}`
        : "";
      if (onSendMessage) {
        onSendMessage(`Wire in ${mod.name} (${mod.provider}) for this app${secretsList}. Follow the official ${mod.provider} Expo SDK patterns: correct imports, initialization in app/_layout.tsx, typed hooks, error boundaries, and loading states. Add all required packages to package.json.`);
      }
    }
  };

  const handleAddSecret = (modId: string) => {
    if (!newSecretName || !newSecretValue) return;
    createSecret.mutate(
      { id: projectId, data: { name: newSecretName, value: newSecretValue, environment: "development" } },
      {
        onSuccess: () => {
          setNewSecretName("");
          setNewSecretValue("");
          setAddSecretFor(null);
          queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
          const mod = MOBILE_MODULES.find((m) => m.id === modId);
          if (mod && onSendMessage) {
            const secretsList = mod.requiredSecrets.join(", ");
            onSendMessage(`Wire in ${mod.name} (${mod.provider}) for this app using the API key stored in ${secretsList}. Follow the official ${mod.provider} Expo SDK patterns.`);
          }
          setActiveModules((prev) => new Set([...prev, modId]));
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Toggle modules to auto-wire them into your app. The AI builder will add the correct SDK code, imports, and initialization.
      </div>

      {MOBILE_MODULES.map((mod) => {
        const status = getModuleStatus(mod);
        const isActive = status === "active";
        const needsSecret = status === "needs-secret";
        const isExpanded = addSecretFor === mod.id;

        return (
          <div
            key={mod.id}
            className={`border rounded-lg overflow-hidden transition-colors ${
              isActive
                ? "border-primary/40 bg-primary/5"
                : needsSecret
                  ? "border-yellow-500/30 bg-yellow-500/5"
                  : "border-border bg-card"
            }`}
          >
            <div className="flex items-start gap-3 p-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{mod.name}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded font-mono">
                    {mod.provider}
                  </span>
                  {isActive && (
                    <Badge variant="default" className="text-[10px] h-4 px-1.5 bg-primary/20 text-primary border-primary/30">
                      Active
                    </Badge>
                  )}
                  {!isActive && !needsSecret && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground border-border">
                      Inactive
                    </Badge>
                  )}
                  {needsSecret && (
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-yellow-500 border-yellow-500/30">
                      Needs secret
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{mod.description}</p>
                {mod.requiredSecrets.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <KeyRound className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                    {mod.requiredSecrets.map((s) => (
                      <span
                        key={s}
                        className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                          secretNames.has(s)
                            ? "text-green-400 bg-green-500/10"
                            : "text-yellow-400 bg-yellow-500/10"
                        }`}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                {mod.packageDependencies.length > 0 && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <Package className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                    {mod.packageDependencies.slice(0, 2).map((p) => (
                      <span key={p} className="text-[10px] font-mono text-muted-foreground">
                        {p}
                      </span>
                    ))}
                    {mod.packageDependencies.length > 2 && (
                      <span className="text-[10px] text-muted-foreground">+{mod.packageDependencies.length - 2} more</span>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => handleToggle(mod)}
                className={`shrink-0 mt-0.5 transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
                title={isActive ? "Remove module" : needsSecret ? "Add required secret first" : "Wire in module"}
              >
                {isActive ? (
                  <ToggleRight className="h-6 w-6" />
                ) : (
                  <ToggleLeft className="h-6 w-6" />
                )}
              </button>
            </div>

            {isExpanded && (
              <div className="px-3 pb-3 pt-0 border-t border-border bg-background/50 space-y-2">
                <p className="text-xs text-yellow-400 pt-2">
                  Add the required secret to enable this module:
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="Key name"
                    value={newSecretName}
                    onChange={(e) => setNewSecretName(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                  <Input
                    placeholder="Value"
                    type="password"
                    value={newSecretValue}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={() => handleAddSecret(mod.id)}
                    disabled={!newSecretName || !newSecretValue || createSecret.isPending}
                    className="h-8 text-xs whitespace-nowrap"
                  >
                    {createSecret.isPending ? "Saving…" : "Save & wire"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAddSecretFor(null)}
                    className="h-8 text-xs"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ToolsTab({
  projectId,
  projectKind,
  wiredModuleIds,
  prefillSecretName,
  defaultTab,
  onSendMessage,
}: {
  projectId: number;
  projectKind?: string;
  wiredModuleIds?: string[];
  prefillSecretName?: string | null;
  defaultTab?: string;
  onSendMessage?: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const isMobile = projectKind === "mobile-cross" || projectKind === "mobile-ios" || projectKind === "mobile-android";

  const [innerTab, setInnerTab] = useState<string>(
    prefillSecretName ? "secrets" : (defaultTab ?? "files"),
  );

  const { data: files } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const activeFileId =
    selectedFileId ??
    files?.find((f) => f.path === "index.html")?.id ??
    files?.[0]?.id ??
    null;
  const { data: fileContent } = useGetProjectFile(projectId, activeFileId ?? 0, {
    query: {
      enabled: !!projectId && !!activeFileId,
      queryKey: getGetProjectFileQueryKey(projectId, activeFileId ?? 0),
    },
  });

  const { data: versions, isLoading: versionsLoading } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });

  const { data: secrets } = useListSecrets(projectId, {
    query: { enabled: !!projectId, queryKey: getListSecretsQueryKey(projectId) },
  });
  const createSecret = useCreateSecret();

  const [newSecretName, setNewSecretName] = useState(prefillSecretName ?? "");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretEnv, setSecretEnv] = useState<"development" | "testing" | "staging" | "production">("development");

  useEffect(() => {
    if (prefillSecretName) {
      setInnerTab("secrets");
      setNewSecretName(prefillSecretName);
    }
  }, [prefillSecretName]);

  const handleCreateSecret = () => {
    if (!newSecretName || !newSecretValue) return;
    createSecret.mutate(
      {
        id: projectId,
        data: { name: newSecretName, value: newSecretValue, environment: secretEnv },
      },
      {
        onSuccess: () => {
          setNewSecretName("");
          setNewSecretValue("");
          queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
        },
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-2 bg-card flex-1 overflow-hidden">
        <Tabs value={innerTab} onValueChange={setInnerTab} className="w-full h-full flex flex-col">
          <TabsList className="bg-muted flex-wrap h-auto gap-y-1">
            <TabsTrigger value="files">
              <FolderTree className="h-4 w-4 mr-2" /> Files
            </TabsTrigger>
            <TabsTrigger value="versions">
              <HistoryIcon className="h-4 w-4 mr-2" /> Versions
            </TabsTrigger>
            <TabsTrigger value="shell">
              <TerminalSquare className="h-4 w-4 mr-2" /> Shell
            </TabsTrigger>
            <TabsTrigger value="secrets">
              <Lock className="h-4 w-4 mr-2" /> Secrets
            </TabsTrigger>
            <TabsTrigger value="integrations">
              <Blocks className="h-4 w-4 mr-2" /> Integrations
            </TabsTrigger>
            {isMobile && (
              <TabsTrigger value="modules">
                <Puzzle className="h-4 w-4 mr-2" /> Modules
              </TabsTrigger>
            )}
          </TabsList>

          <div className="mt-4 flex-1 h-[calc(100vh-280px)] overflow-y-auto">
            <TabsContent
              value="files"
              className="h-full m-0 border border-border rounded-md flex overflow-hidden"
            >
              <div className="w-60 bg-card border-r border-border p-2 overflow-y-auto">
                {(!files || files.length === 0) && (
                  <div className="text-xs text-muted-foreground p-2">
                    No files yet. Send the AI Builder a message to generate your app.
                  </div>
                )}
                {files?.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setSelectedFileId(f.id)}
                    className={`w-full text-left text-sm flex items-center gap-2 py-1 px-2 rounded ${
                      activeFileId === f.id
                        ? "bg-primary/15 text-primary"
                        : "hover:bg-muted text-muted-foreground"
                    }`}
                    title={f.path}
                  >
                    <FileCode2 className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate font-mono text-xs">{f.path}</span>
                  </button>
                ))}
              </div>
              <div className="flex-1 bg-[#0d1117] p-4 text-[#d4d4d4] font-mono text-xs relative overflow-auto">
                <div className="absolute top-2 right-2 flex items-center gap-2">
                  {fileContent && (
                    <span className="text-[10px] text-muted-foreground px-2 py-1 bg-background/30 rounded">
                      {fileContent.mimeType}
                    </span>
                  )}
                  <Button size="sm" variant="secondary" disabled>
                    <Save className="h-4 w-4 mr-2" /> Read only
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap break-words mt-10">
                  <code>{fileContent?.content ?? "// Select a file"}</code>
                </pre>
              </div>
            </TabsContent>

            <TabsContent value="versions" className="h-full m-0 pt-2">
              <VersionTimeline
                projectId={projectId}
                versions={versions}
                isLoading={versionsLoading}
                currentFiles={files ?? []}
              />
            </TabsContent>

            <TabsContent
              value="shell"
              className="h-full m-0 border border-border rounded-md bg-black p-4 text-green-400 font-mono text-sm"
            >
              <div className="text-gray-400">
                Shell access is not exposed in this prototype. The AI Builder runs generation server-side; check
                Versions for change history and Logs for activity.
              </div>
            </TabsContent>

            <TabsContent value="secrets" className="h-full m-0 p-4 space-y-6">
              <div className="grid grid-cols-4 gap-3 border border-border rounded-lg p-4 bg-card">
                <div className="col-span-4 font-semibold mb-1">Add new secret</div>
                <Input
                  placeholder="Key (e.g. STRIPE_API_KEY)"
                  value={newSecretName}
                  onChange={(e) => setNewSecretName(e.target.value)}
                />
                <Input
                  placeholder="Value"
                  type="password"
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                />
                <select
                  className="bg-background border border-border rounded-md px-2 text-sm"
                  value={secretEnv}
                  onChange={(e) => setSecretEnv(e.target.value as "development" | "testing" | "staging" | "production")}
                >
                  <option value="development">Development</option>
                  <option value="testing">Testing</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                </select>
                <Button
                  onClick={handleCreateSecret}
                  disabled={!newSecretName || !newSecretValue || createSecret.isPending}
                >
                  {createSecret.isPending ? "Adding..." : "Add secret"}
                </Button>
                <div className="col-span-4 text-xs text-muted-foreground">
                  Values are never returned by the API — only a masked preview. Separate test and production
                  secrets so the AI Builder can target the right environment.
                </div>
              </div>

              {(!secrets || secrets.length === 0) ? (
                <div className="border border-border rounded-lg p-8 text-center text-muted-foreground bg-card">
                  No secrets configured yet. Add your first key above.
                </div>
              ) : (
                <div className="space-y-4">
                  {(["development", "testing", "staging", "production"] as const).map((env) => {
                    const envSecrets = secrets.filter((s) => s.environment === env);
                    if (envSecrets.length === 0) return null;
                    const envConfig = {
                      development: { label: "Development", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
                      testing: { label: "Testing", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
                      staging: { label: "Staging", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
                      production: { label: "Production", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
                    }[env];
                    return (
                      <div key={env} className="border border-border rounded-lg overflow-hidden bg-card">
                        <div className={`px-4 py-2 border-b border-border flex items-center gap-2 ${envConfig.bg}`}>
                          <span className={`text-xs font-semibold uppercase tracking-wider ${envConfig.color}`}>{envConfig.label} Keys</span>
                          <span className="text-xs text-muted-foreground ml-auto">{envSecrets.length} secret{envSecrets.length !== 1 ? "s" : ""}</span>
                        </div>
                        <div className="divide-y divide-border">
                          {envSecrets.map((s) => (
                            <div key={s.id} className="flex items-center gap-3 p-3 text-sm min-w-0">
                              <div className="font-mono text-foreground truncate flex-1 min-w-0">{s.name}</div>
                              <div className="font-mono text-muted-foreground flex items-center gap-1.5 shrink-0">
                                <Lock className="h-3 w-3 shrink-0" />
                                {s.masked}
                              </div>
                              <SecretVerifyButton
                                secretId={s.id}
                                projectId={projectId}
                                initialStatus={s.verificationStatus ?? "unverified"}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex items-start gap-2 text-xs text-muted-foreground mt-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Secret values are never returned by the API. Use Development keys for local testing, Test keys for staging, and Production keys for your live app.
              </div>
            </TabsContent>

            <TabsContent value="integrations" className="h-full m-0 p-4">
              <IntegrationsRegistry projectId={projectId} secrets={secrets ?? []} />
            </TabsContent>

            {isMobile && (
              <TabsContent value="modules" className="h-full m-0 p-4">
                <ModuleLibrary
                  projectId={projectId}
                  secrets={secrets ?? []}
                  wiredModuleIds={wiredModuleIds}
                  onSendMessage={onSendMessage}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
