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
} from "lucide-react";
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
  const [secretEnv, setSecretEnv] = useState<"test" | "production">("production");

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
                  onChange={(e) => setSecretEnv(e.target.value as "test" | "production")}
                >
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

              <div className="border border-border rounded-lg overflow-hidden bg-card">
                <div className="grid grid-cols-3 gap-4 p-3 bg-muted border-b border-border font-medium text-sm">
                  <div>Key</div>
                  <div>Value</div>
                  <div>Environment</div>
                </div>
                {secrets?.map((s) => (
                  <div
                    key={s.id}
                    className="grid grid-cols-3 gap-4 p-3 border-b border-border text-sm last:border-0"
                  >
                    <div className="font-mono">{s.name}</div>
                    <div className="font-mono text-muted-foreground">{s.masked}</div>
                    <div>
                      <span className="px-2 py-1 bg-secondary/20 text-secondary rounded text-xs">
                        {s.environment}
                      </span>
                    </div>
                  </div>
                ))}
                {(!secrets || secrets.length === 0) && (
                  <div className="p-8 text-center text-muted-foreground">No secrets configured.</div>
                )}
              </div>
            </TabsContent>

            <TabsContent
              value="integrations"
              className="h-full m-0 p-4 grid grid-cols-1 md:grid-cols-3 gap-4"
            >
              {["OpenAI", "Supabase", "Stripe", "Resend", "Google Maps", "Twilio"].map(
                (integration) => (
                  <div
                    key={integration}
                    className="border border-border rounded-lg p-4 bg-card flex flex-col items-start gap-4"
                  >
                    <div className="h-10 w-10 bg-primary/20 rounded-lg flex items-center justify-center">
                      <Blocks className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{integration}</h3>
                      <p className="text-sm text-muted-foreground">
                        The AI Builder will recommend this when your project needs it and tell you which keys to
                        add in Secrets.
                      </p>
                    </div>
                  </div>
                ),
              )}
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
