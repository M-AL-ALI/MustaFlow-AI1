import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Database,
  Play,
  TableProperties,
  AlertCircle,
  Loader2,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  useGetProject,
  useGetDatabaseStatus,
  useProvisionDatabase,
  useDeprovisionDatabase,
  useQueryDatabase,
  useGetDatabaseSchema,
  getGetDatabaseStatusQueryKey,
  getGetProjectQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

interface DatabaseTabProps {
  projectId: number;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "connected")
    return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Connected</Badge>;
  if (status === "provisioning")
    return (
      <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Provisioning</Badge>
    );
  if (status === "error")
    return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Error</Badge>;
  return <Badge variant="secondary">Not provisioned</Badge>;
}

function SchemaTable({
  table,
}: {
  table: {
    tableName: string;
    columns: { name: string; type: string; nullable: boolean; isPrimaryKey?: boolean }[];
  };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-card hover:bg-muted text-sm font-medium text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
        <TableProperties className="h-4 w-4 flex-shrink-0 text-blue-400" />
        <span className="font-mono">{table.tableName}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {table.columns.length} col{table.columns.length !== 1 ? "s" : ""}
        </span>
      </button>
      {open && (
        <table className="w-full text-xs font-mono border-t border-border">
          <thead>
            <tr className="bg-muted/50">
              <th className="px-3 py-1 text-left text-muted-foreground font-medium">column</th>
              <th className="px-3 py-1 text-left text-muted-foreground font-medium">type</th>
              <th className="px-3 py-1 text-left text-muted-foreground font-medium">nullable</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((col) => (
              <tr key={col.name} className="border-t border-border/50">
                <td className="px-3 py-1 text-foreground">{col.name}</td>
                <td className="px-3 py-1 text-blue-400">{col.type}</td>
                <td className="px-3 py-1 text-muted-foreground">{col.nullable ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function DatabaseTab({ projectId }: DatabaseTabProps) {
  const queryClient = useQueryClient();
  const [activeView, setActiveView] = useState<"schema" | "query">("schema");
  const [sql, setSql] = useState("SELECT * FROM ");
  const [queryResult, setQueryResult] = useState<{
    columns: string[];
    rows: unknown[][];
    rowCount: number;
  } | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const { data: project } = useGetProject(projectId);
  const { data: dbStatus, isLoading: statusLoading } = useGetDatabaseStatus(projectId);
  const { mutate: provision, isPending: provisioning } = useProvisionDatabase();
  const { mutate: deleteDb, isPending: deleting } = useDeprovisionDatabase();
  const { mutate: runQuery, isPending: querying } = useQueryDatabase();
  const { data: schemaData, isLoading: schemaLoading } = useGetDatabaseSchema(projectId);

  const isProvisioned = dbStatus?.dbStatus === "connected";
  const isProvisioning = dbStatus?.dbStatus === "provisioning" || provisioning;
  const _dbProvider = (project as { dbProvider?: string })?.dbProvider ?? "none";

  function handleProvision(provider: "postgres" | "sqlite") {
    provision(
      { id: projectId, data: { provider } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetDatabaseStatusQueryKey(projectId) });
          void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        },
      },
    );
  }

  function handleDelete() {
    if (!confirm("Delete this database? This is permanent and cannot be undone.")) return;
    deleteDb(
      { id: projectId },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetDatabaseStatusQueryKey(projectId) });
          void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
          setQueryResult(null);
        },
      },
    );
  }

  function handleQuery() {
    setQueryError(null);
    setQueryResult(null);
    runQuery(
      { id: projectId, data: { sql } },
      {
        onSuccess: (data) => {
          setQueryResult({
            columns: data.columns ?? [],
            rows: (data.rows ?? []) as unknown[][],
            rowCount: data.rowCount ?? 0,
          });
        },
        onError: (err) => {
          setQueryError((err as Error).message ?? "Query failed");
        },
      },
    );
  }

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading database status…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border border-border rounded-lg p-4 bg-card">
        <div className="flex items-center gap-3">
          <Database className="h-5 w-5 text-blue-400 flex-shrink-0" />
          <div>
            <div className="font-semibold flex items-center gap-2">
              Project Database
              <StatusBadge status={dbStatus?.dbStatus ?? "none"} />
            </div>
            {isProvisioned && dbStatus?.maskedUrl && (
              <div className="text-xs text-muted-foreground font-mono mt-0.5">
                {dbStatus.maskedUrl}
              </div>
            )}
            {!isProvisioned && !isProvisioning && (
              <div className="text-xs text-muted-foreground mt-0.5">
                No database provisioned for this project.
              </div>
            )}
          </div>
        </div>
        {isProvisioned && (
          <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
          </Button>
        )}
      </div>

      {/* Provision UI */}
      {!isProvisioned && !isProvisioning && (
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <div className="font-medium text-sm">Add a database to this project</div>
          <p className="text-xs text-muted-foreground">
            Provision a database and inject{" "}
            <code className="bg-muted px-1 rounded">DATABASE_URL</code> as a project secret
            automatically. The AI builder will then generate real database-backed code.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => handleProvision("postgres")} disabled={provisioning}>
              {provisioning ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Database className="h-4 w-4 mr-2" />
              )}
              Add PostgreSQL
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => handleProvision("sqlite")}
              disabled={provisioning}
            >
              Add SQLite
            </Button>
          </div>
        </div>
      )}

      {isProvisioning && !isProvisioned && (
        <div className="border border-yellow-500/20 rounded-lg p-4 bg-yellow-500/5 flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-yellow-400 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-yellow-300">Provisioning database…</div>
            <div className="text-xs text-muted-foreground">
              This usually takes 5–15 seconds. DATABASE_URL will be injected as a secret when ready.
            </div>
          </div>
        </div>
      )}

      {/* Browser tabs */}
      {isProvisioned && (
        <>
          <div className="flex gap-1 border-b border-border">
            <button
              className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                activeView === "schema"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveView("schema")}
            >
              Schema
            </button>
            <button
              className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                activeView === "query"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveView("query")}
            >
              Query
            </button>
          </div>

          {activeView === "schema" && (
            <div className="flex-1 overflow-y-auto space-y-2">
              {schemaLoading && (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading schema…
                </div>
              )}
              {!schemaLoading && (!schemaData?.tables || schemaData.tables.length === 0) && (
                <div className="text-sm text-muted-foreground border border-border rounded-lg p-4 bg-card">
                  No tables found. Ask the AI to build your app — it will generate Drizzle schema
                  files and run migrations automatically.
                </div>
              )}
              {schemaData?.tables?.map((t) => (
                <SchemaTable key={t.tableName} table={t} />
              ))}
            </div>
          )}

          {activeView === "query" && (
            <div className="flex flex-col gap-3 flex-1">
              <div className="relative">
                <Textarea
                  className="font-mono text-sm min-h-[100px] bg-[#0d1117] text-[#d4d4d4] border-border resize-none"
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  placeholder="SELECT * FROM users LIMIT 10"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  className="absolute bottom-2 right-2"
                  onClick={handleQuery}
                  disabled={querying || !sql.trim()}
                >
                  {querying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  <span className="ml-1">Run</span>
                </Button>
              </div>

              {queryError && (
                <div className="flex items-start gap-2 border border-red-500/30 rounded-lg p-3 bg-red-500/5 text-red-400 text-sm">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span className="font-mono text-xs">{queryError}</span>
                </div>
              )}

              {queryResult && (
                <div className="flex-1 overflow-auto border border-border rounded-lg">
                  <div className="text-xs text-muted-foreground px-3 py-1.5 bg-muted/50 border-b border-border">
                    {queryResult.rowCount} row{queryResult.rowCount !== 1 ? "s" : ""} returned
                  </div>
                  {queryResult.columns.length > 0 ? (
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="bg-muted/30">
                          {queryResult.columns.map((col) => (
                            <th
                              key={col}
                              className="px-3 py-1.5 text-left text-muted-foreground font-medium border-b border-border whitespace-nowrap"
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResult.rows.map((row, ri) => (
                          <tr key={ri} className="border-t border-border/50 hover:bg-muted/20">
                            {(row as unknown[]).map((cell, ci) => (
                              <td
                                key={ci}
                                className="px-3 py-1 text-foreground whitespace-nowrap max-w-[300px] truncate"
                              >
                                {cell === null ? (
                                  <span className="text-muted-foreground italic">null</span>
                                ) : (
                                  String(cell)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="p-3 text-sm text-muted-foreground">
                      Query completed with no rows.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
