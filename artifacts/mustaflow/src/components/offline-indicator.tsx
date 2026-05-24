import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export function OfflineIndicator() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // Check initial state
    setOffline(!navigator.onLine);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full bg-destructive text-destructive-foreground text-sm font-medium shadow-lg"
      role="alert"
      aria-live="assertive"
    >
      <WifiOff className="h-4 w-4 flex-shrink-0" />
      You are offline — changes may not save
    </div>
  );
}
