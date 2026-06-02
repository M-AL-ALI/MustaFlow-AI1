import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { LayoutDashboard, ArrowRight, RefreshCw } from "lucide-react";

type RequestStatus =
  | "pending"
  | "quoted"
  | "counter_offered"
  | "accepted"
  | "in_progress"
  | "completed"
  | "cancelled";

interface TowRequest {
  id: string;
  customerName: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  status: RequestStatus;
  createdAt: string;
}

const STATUS_COLORS: Record<RequestStatus, string> = {
  pending: "bg-yellow-900/40 text-yellow-400 border-yellow-800/60",
  quoted: "bg-blue-900/40 text-blue-400 border-blue-800/60",
  counter_offered: "bg-purple-900/40 text-purple-400 border-purple-800/60",
  accepted: "bg-green-900/40 text-green-400 border-green-800/60",
  in_progress: "bg-orange-900/40 text-orange-400 border-orange-800/60",
  completed: "bg-slate-800 text-slate-400 border-slate-700",
  cancelled: "bg-red-900/40 text-red-400 border-red-800/60",
};

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Pending",
  quoted: "Quoted",
  counter_offered: "Counter Offered",
  accepted: "Accepted",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export default function CustomerDashboard() {
  const [requests, setRequests] = useState<TowRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/requests");
      if (!r.ok) throw new Error("Failed to load");
      setRequests(await r.json());
    } catch {
      setError("Could not load requests.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-orange-500 text-sm font-medium">
            <LayoutDashboard className="h-4 w-4" />
            Customer Dashboard
          </div>
          <h1 className="text-2xl font-bold text-white">My Tow Requests</h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={load}
            className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <Link
            to="/request"
            className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            New Request
          </Link>
        </div>
      </div>

      {loading && (
        <div className="text-center py-20 text-slate-500">Loading requests...</div>
      )}
      {error && !loading && (
        <div className="text-center py-20 text-red-400">{error}</div>
      )}
      {!loading && !error && requests.length === 0 && (
        <div className="text-center py-20 space-y-3">
          <p className="text-slate-400">No requests yet.</p>
          <Link
            to="/request"
            className="inline-flex items-center gap-1 text-orange-400 hover:text-orange-300 text-sm"
          >
            Create your first tow request <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {requests.map((req) => (
          <Link
            key={req.id}
            to={`/request/${req.id}`}
            className="block bg-slate-900 border border-slate-800 hover:border-slate-600 rounded-xl p-5 transition-colors group"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border font-medium ${STATUS_COLORS[req.status]}`}
                  >
                    {STATUS_LABEL[req.status]}
                  </span>
                  <span className="text-xs text-slate-500">
                    {new Date(req.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-white font-medium truncate">
                  {req.pickupAddress} &rarr; {req.dropoffAddress}
                </p>
                <p className="text-sm text-slate-400">
                  {req.vehicleYear} {req.vehicleMake} {req.vehicleModel} &middot; {req.customerName}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 text-slate-600 group-hover:text-slate-400 flex-shrink-0 mt-1 transition-colors" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
