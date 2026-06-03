import { authFetch } from "@/lib/api-fetch";
import { useState } from "react";
import { useLocation } from "wouter";
import { Building2, ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function OrgNewPage() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) return;
    setError("");
    setCreating(true);
    try {
      const r = await authFetch("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          billingEmail: billingEmail.trim() || undefined,
        }),
      });
      if (r.ok) {
        const org = (await r.json()) as { id: number };
        setLocation(`/orgs/${org.id}`);
      } else {
        const d = (await r.json()) as { error?: string };
        setError(d.error ?? "Failed to create organization");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-md mx-auto px-4 py-16 space-y-8">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={() => setLocation("/projects")}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold">New organization</h1>
            <p className="text-sm text-muted-foreground">Collaborate with your team</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Organization name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does your team build?"
              className="min-h-[80px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Billing email <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              placeholder="billing@acme.com"
              type="email"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            className="w-full"
            onClick={() => void handleCreate()}
            disabled={creating || !name.trim()}
          >
            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
            Create organization
          </Button>
        </div>
      </div>
    </div>
  );
}
