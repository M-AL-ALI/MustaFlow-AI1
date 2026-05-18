import { Button } from "@/components/ui/button";
import { Globe, Smartphone, PlaySquare, ArrowUpRight } from "lucide-react";

export function PublishingTab() {
  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h2 className="text-2xl font-bold mb-2">Publishing & Deployment</h2>
          <p className="text-muted-foreground">Manage where your application is deployed and available to users.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border border-border rounded-xl p-6 bg-card space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-primary/20 p-2 rounded-lg text-primary"><Globe className="h-6 w-6" /></div>
              <h3 className="text-lg font-semibold">Web Deployment</h3>
            </div>
            <p className="text-sm text-muted-foreground">Deploy your web app to a custom domain with global edge caching.</p>
            <div className="bg-muted p-3 rounded-lg flex justify-between items-center text-sm">
              <span className="font-mono">mustaflow.app/projects/xyz</span>
              <span className="text-green-500 flex items-center"><span className="w-2 h-2 rounded-full bg-green-500 mr-2" /> Active</span>
            </div>
            <Button className="w-full">Configure Custom Domain</Button>
          </div>

          <div className="border border-border rounded-xl p-6 bg-card space-y-4">
            <div className="flex items-center gap-3">
              <div className="bg-primary/20 p-2 rounded-lg text-primary"><Smartphone className="h-6 w-6" /></div>
              <h3 className="text-lg font-semibold">App Stores</h3>
            </div>
            <p className="text-sm text-muted-foreground">Submit your iOS and Android apps to Apple App Store and Google Play.</p>
            <div className="space-y-2">
              <div className="bg-muted p-3 rounded-lg flex justify-between items-center text-sm">
                <span>iOS TestFlight</span>
                <Button variant="outline" size="sm">Setup <ArrowUpRight className="h-3 w-3 ml-1" /></Button>
              </div>
              <div className="bg-muted p-3 rounded-lg flex justify-between items-center text-sm">
                <span>Google Play Console</span>
                <Button variant="outline" size="sm">Setup <ArrowUpRight className="h-3 w-3 ml-1" /></Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
