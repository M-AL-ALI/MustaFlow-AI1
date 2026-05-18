import { useState } from "react";
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
  RotateCcw,
  Info,
} from "lucide-react";
import { IntegrationsRegistry } from "./integrations-registry";
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
  useRollbackVersion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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

  // Versions / rollback
  const { data: versions } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });
  const rollback = useRollbackVersion();

  // Secrets
  const { data: secrets } = useListSecrets(projectId, {
    query: { enabled: !!projectId, queryKey: getListSecretsQueryKey(projectId) },
  });
  const createSecret = useCreateSecret();

  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [secretEnv, setSecretEnv] = useState<"development" | "test" | "production">("development");

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

  const handleRollback = (versionId: number) => {
    if (!window.confirm("Restore project files to this version? This replaces the current files.")) return;
    rollback.mutate(
      { id: projectId, versionId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
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

            <TabsContent value="versions" className="h-full m-0 p-4 space-y-2">
              {(!versions || versions.length === 0) && (
                <div className="p-8 text-center text-muted-foreground border border-border rounded-lg bg-card">
                  No saved versions yet. The AI Builder snapshots a version after each successful build or change.
                </div>
              )}
              {versions?.map((v) => (
                <div
                  key={v.id}
                  className="border border-border rounded-lg p-4 bg-card flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{v.label}</div>
                    {v.note && (
                      <div className="text-sm text-muted-foreground mt-1 line-clamp-2">{v.note}</div>
                    )}
                    <div className="text-xs text-muted-foreground mt-2">
                      {new Date(v.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRollback(v.id)}
                    disabled={rollback.isPending}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-2" />
                    Roll back
                  </Button>
                </div>
              ))}
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
                  onChange={(e) => setSecretEnv(e.target.value as "development" | "test" | "production")}
                >
                  <option value="development">Development</option>
                  <option value="test">Test</option>
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
                  {(["development", "test", "production"] as const).map((env) => {
                    const envSecrets = secrets.filter((s) => s.environment === env);
                    if (envSecrets.length === 0) return null;
                    const envConfig = {
                      development: { label: "Development", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
                      test: { label: "Test", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
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
                            <div key={s.id} className="grid grid-cols-2 gap-4 p-3 text-sm">
                              <div className="font-mono text-foreground truncate">{s.name}</div>
                              <div className="font-mono text-muted-foreground flex items-center gap-1.5">
                                <Lock className="h-3 w-3 shrink-0" />
                                {s.masked}
                              </div>
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
              <IntegrationsRegistry projectId={projectId} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
