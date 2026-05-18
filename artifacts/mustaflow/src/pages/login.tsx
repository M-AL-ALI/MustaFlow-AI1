import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Waves } from "lucide-react";
import { Link } from "wouter";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full border border-border rounded-2xl p-8 bg-card shadow-2xl">
        <div className="flex flex-col items-center mb-8">
          <div className="bg-primary text-primary-foreground p-3 rounded-xl mb-4 shadow-lg shadow-primary/20">
            <Waves className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome to MustaFlow AI</h1>
          <p className="text-muted-foreground text-center mt-2">Sign in to continue to your workspace.</p>
        </div>
        
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Email</label>
            <Input placeholder="you@example.com" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Password</label>
            <Input type="password" placeholder="••••••••" />
          </div>
          <Link href="/">
            <Button className="w-full mt-4" size="lg">Sign In</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}