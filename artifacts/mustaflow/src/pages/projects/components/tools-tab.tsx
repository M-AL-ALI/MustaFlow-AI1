import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderTree, FileCode2, TerminalSquare, Lock, Blocks, Save, Check } from "lucide-react";
import { useListSecrets, useCreateSecret, getListSecretsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export function ToolsTab({ projectId }: { projectId: number }) {
  const { data: secrets } = useListSecrets(projectId, {
    query: { enabled: !!projectId, queryKey: getListSecretsQueryKey(projectId) },
  });
  const createSecret = useCreateSecret();
  const queryClient = useQueryClient();
  
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");

  const handleCreateSecret = () => {
    if (!newSecretName || !newSecretValue) return;
    createSecret.mutate({
      id: projectId,
      data: {
        name: newSecretName,
        value: newSecretValue,
        environment: "production"
      }
    }, {
      onSuccess: () => {
        setNewSecretName("");
        setNewSecretValue("");
        queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
      }
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-2 bg-card">
        <Tabs defaultValue="files" className="w-full">
          <TabsList className="bg-muted">
            <TabsTrigger value="files"><FolderTree className="h-4 w-4 mr-2" /> Files</TabsTrigger>
            <TabsTrigger value="shell"><TerminalSquare className="h-4 w-4 mr-2" /> Shell</TabsTrigger>
            <TabsTrigger value="secrets"><Lock className="h-4 w-4 mr-2" /> Secrets</TabsTrigger>
            <TabsTrigger value="integrations"><Blocks className="h-4 w-4 mr-2" /> Integrations</TabsTrigger>
          </TabsList>

          <div className="mt-4 flex-1 h-[calc(100vh-280px)] overflow-y-auto">
            <TabsContent value="files" className="h-full m-0 border border-border rounded-md flex overflow-hidden">
              <div className="w-48 bg-card border-r border-border p-2">
                <div className="text-sm flex items-center gap-2 py-1 px-2 hover:bg-muted rounded text-muted-foreground"><FolderTree className="h-4 w-4" /> src</div>
                <div className="text-sm flex items-center gap-2 py-1 px-2 ml-4 bg-primary/10 text-primary rounded"><FileCode2 className="h-4 w-4" /> App.tsx</div>
                <div className="text-sm flex items-center gap-2 py-1 px-2 ml-4 hover:bg-muted rounded text-muted-foreground"><FileCode2 className="h-4 w-4" /> index.css</div>
              </div>
              <div className="flex-1 bg-[#1e1e1e] p-4 text-[#d4d4d4] font-mono text-sm relative">
                <div className="absolute top-4 right-4"><Button size="sm" variant="secondary" disabled><Save className="h-4 w-4 mr-2" /> Save</Button></div>
                <pre><code>{`import React from 'react';\n\nexport default function App() {\n  return (\n    <div className="app">\n      <h1>Hello MustaFlow!</h1>\n    </div>\n  );\n}`}</code></pre>
              </div>
            </TabsContent>

            <TabsContent value="shell" className="h-full m-0 border border-border rounded-md bg-black p-4 text-green-400 font-mono text-sm">
              <div>$ npm run dev</div>
              <div className="text-gray-400">Vite server started at http://localhost:3000</div>
              <div className="mt-4 flex"><span className="mr-2">$</span><span className="w-2 h-4 bg-green-400 animate-pulse" /></div>
            </TabsContent>

            <TabsContent value="secrets" className="h-full m-0 p-4 space-y-6">
              <div className="grid grid-cols-3 gap-4 border border-border rounded-lg p-4 bg-card">
                <div className="col-span-3 font-semibold mb-2">Add New Secret</div>
                <Input placeholder="Key (e.g. STRIPE_API_KEY)" value={newSecretName} onChange={(e) => setNewSecretName(e.target.value)} />
                <Input placeholder="Value" type="password" value={newSecretValue} onChange={(e) => setNewSecretValue(e.target.value)} />
                <Button onClick={handleCreateSecret} disabled={!newSecretName || !newSecretValue || createSecret.isPending}>
                  {createSecret.isPending ? "Adding..." : "Add Secret"}
                </Button>
              </div>
              
              <div className="border border-border rounded-lg overflow-hidden bg-card">
                <div className="grid grid-cols-3 gap-4 p-3 bg-muted border-b border-border font-medium text-sm">
                  <div>Key</div>
                  <div>Value</div>
                  <div>Environment</div>
                </div>
                {secrets?.map(s => (
                  <div key={s.id} className="grid grid-cols-3 gap-4 p-3 border-b border-border text-sm last:border-0">
                    <div className="font-mono">{s.name}</div>
                    <div className="font-mono text-muted-foreground">{s.masked}</div>
                    <div><span className="px-2 py-1 bg-secondary/20 text-secondary rounded text-xs">{s.environment}</span></div>
                  </div>
                ))}
                {(!secrets || secrets.length === 0) && (
                  <div className="p-8 text-center text-muted-foreground">No secrets configured.</div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="integrations" className="h-full m-0 p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              {['OpenAI', 'Supabase', 'Stripe', 'Resend', 'Google Maps'].map(integration => (
                <div key={integration} className="border border-border rounded-lg p-4 bg-card flex flex-col items-start gap-4">
                  <div className="h-10 w-10 bg-primary/20 rounded-lg flex items-center justify-center"><Blocks className="h-5 w-5 text-primary" /></div>
                  <div>
                    <h3 className="font-semibold">{integration}</h3>
                    <p className="text-sm text-muted-foreground">Connect {integration} API</p>
                  </div>
                  <Button variant="outline" className="w-full mt-auto">Connect</Button>
                </div>
              ))}
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
