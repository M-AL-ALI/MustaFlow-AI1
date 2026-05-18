import { useListKnowledge } from "@workspace/api-client-react";

export default function KnowledgePage() {
  const { data: knowledge } = useListKnowledge();

  return (
    <div className="p-8 max-w-7xl mx-auto w-full">
      <h1 className="text-3xl font-bold tracking-tight mb-8">Knowledge Vault</h1>
      <div className="grid gap-4">
        {knowledge?.map((entry) => (
          <div key={entry.id} className="border border-border rounded-lg p-4 bg-card">
            <h3 className="font-medium">{entry.title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{entry.category}</p>
          </div>
        ))}
        {(!knowledge || knowledge.length === 0) && (
          <div className="text-muted-foreground">No knowledge entries yet.</div>
        )}
      </div>
    </div>
  );
}