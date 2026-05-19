import { useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export function ToolsTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();

  // Files
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

  // Versions
  const { data: versions, isLoading: versionsLoading } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });

  // Secrets
  const { data: secrets } = useListSecrets(projectId, {
    query: { enabled: !!projectId, queryKey: getListSecretsQueryKey(projectId) },
  });
  const createSecret = useCreateSecret();

  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretEnv, setSecretEnv] = useState<"development" | "testing" | "staging" | "production">("development");

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
        <Tabs defaultValue="files" className="w-full h-full flex flex-col">
          <TabsList className="bg-muted">
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
          </div>
        </Tabs>
      </div>
    </div>
  );
}
