import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Star,
  Clock,
  DollarSign,
  CheckCircle,
  XCircle,
  ArrowLeftRight,
  RefreshCw,
} from "lucide-react";

type RequestStatus =
  | "pending"
  | "quoted"
  | "counter_offered"
  | "accepted"
  | "in_progress"
  | "completed"
  | "cancelled";

type QuoteStatus = "pending" | "accepted" | "rejected" | "countered";

interface Quote {
  id: string;
  operatorName: string;
  operatorRating: number;
  price: number;
  eta: number;
  notes: string;
  status: QuoteStatus;
  counterOffer: number | null;
}

interface TowRequest {
  id: string;
  customerName: string;
  customerPhone: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  notes: string;
  status: RequestStatus;
  createdAt: string;
  quotes?: Quote[];
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Pending",
  quoted: "Quoted",
  counter_offered: "Counter Offered",
  accepted: "Accepted",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<RequestStatus, string> = {
  pending: "text-yellow-400",
  quoted: "text-blue-400",
  counter_offered: "text-purple-400",
  accepted: "text-green-400",
  in_progress: "text-orange-400",
  completed: "text-slate-400",
  cancelled: "text-red-400",
};

export default function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const [request, setRequest] = useState<TowRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [counterPrice, setCounterPrice] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/requests/${id}`);
      if (!r.ok) throw new Error("Not found");
      setRequest(await r.json());
    } catch {
      setError("Could not load request.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: string, quoteId: string, body?: object) {
    setActing(quoteId + action);
    try {
      await fetch(`/api/quotes/${quoteId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      await load();
    } finally {
      setActing(null);
    }
  }

  if (loading)
    return (
      <div className="flex items-center justify-center min-h-64 text-slate-500">Loading...</div>
    );

  if (error || !request)
    return (
      <div className="max-w-2xl mx-auto px-4 py-10 text-center space-y-4">
        <p className="text-red-400">{error ?? "Request not found."}</p>
        <Link to="/customer" className="text-orange-400 hover:text-orange-300 text-sm">
          &larr; Back to dashboard
        </Link>
      </div>
    );

  const quotes: Quote[] = request.quotes ?? [];
  const acceptedQuote = quotes.find((q) => q.status === "accepted");

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          to="/customer"
          className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-white">Request Detail</h1>
            <span className={`text-sm font-medium ${STATUS_COLORS[request.status]}`}>
              {STATUS_LABEL[request.status]}
            </span>
          </div>
          <p className="text-sm text-slate-400 truncate">
            {request.pickupAddress} &rarr; {request.dropoffAddress}
          </p>
        </div>
        <button
          onClick={load}
          className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white flex-shrink-0"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Request info */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <span className="text-slate-500 block">Customer</span>
          <span className="text-white">{request.customerName}</span>
        </div>
        <div>
          <span className="text-slate-500 block">Phone</span>
          <span className="text-white">{request.customerPhone}</span>
        </div>
        <div>
          <span className="text-slate-500 block">Vehicle</span>
          <span className="text-white">
            {request.vehicleYear} {request.vehicleMake} {request.vehicleModel}
          </span>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <span className="text-slate-500 block">Pickup</span>
          <span className="text-white">{request.pickupAddress}</span>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <span className="text-slate-500 block">Dropoff</span>
          <span className="text-white">{request.dropoffAddress}</span>
        </div>
        {request.notes && (
          <div className="col-span-2 sm:col-span-3">
            <span className="text-slate-500 block">Notes</span>
            <span className="text-white">{request.notes}</span>
          </div>
        )}
      </div>

      {/* Accepted quote banner */}
      {acceptedQuote && (
        <div className="bg-green-950/20 border border-green-800/50 rounded-xl p-5 space-y-2">
          <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
            <CheckCircle className="h-4 w-4" />
            Accepted Quote
          </div>
          <div className="flex items-center gap-6 text-white">
            <span className="flex items-center gap-1">
              <DollarSign className="h-4 w-4 text-green-400" />
              {Number(acceptedQuote.price).toFixed(2)}
            </span>
            <span className="flex items-center gap-1 text-slate-300">
              <Clock className="h-4 w-4 text-slate-400" />
              {acceptedQuote.eta} min
            </span>
            <span className="flex items-center gap-1 text-slate-300">
              <Star className="h-4 w-4 text-yellow-400" />
              {Number(acceptedQuote.operatorRating).toFixed(1)}
            </span>
          </div>
          <p className="text-slate-300 text-sm">
            Operator: <span className="text-white">{acceptedQuote.operatorName}</span>
          </p>
          {acceptedQuote.notes && (
            <p className="text-slate-400 text-sm">&ldquo;{acceptedQuote.notes}&rdquo;</p>
          )}
        </div>
      )}

      {/* All quotes */}
      {quotes.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-slate-300">All Quotes ({quotes.length})</h2>
          {quotes.map((q) => {
            const isPending = q.status === "pending";
            const isCountered = q.status === "countered";
            const busy = (a: string) => acting === q.id + a;
            const cp = counterPrice[q.id] ?? "";
            return (
              <div
                key={q.id}
                className={`bg-slate-900 border rounded-xl p-5 space-y-3 ${
                  q.status === "accepted" ? "border-green-800/50" : "border-slate-800"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-white font-medium">{q.operatorName}</p>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="flex items-center gap-1 text-white">
                        <DollarSign className="h-3.5 w-3.5 text-slate-400" />
                        {Number(q.price).toFixed(2)}
                      </span>
                      <span className="flex items-center gap-1 text-slate-400">
                        <Clock className="h-3.5 w-3.5" />
                        {q.eta} min
                      </span>
                      <span className="flex items-center gap-1 text-slate-400">
                        <Star className="h-3.5 w-3.5 text-yellow-500" />
                        {Number(q.operatorRating).toFixed(1)}
                      </span>
                    </div>
                    {q.notes && (
                      <p className="text-slate-400 text-sm">&ldquo;{q.notes}&rdquo;</p>
                    )}
                    {isCountered && q.counterOffer && (
                      <p className="text-purple-300 text-sm">
                        Counter offer: <strong>${Number(q.counterOffer).toFixed(2)}</strong>
                      </p>
                    )}
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      q.status === "accepted"
                        ? "border-green-800 text-green-400 bg-green-950/30"
                        : q.status === "rejected"
                        ? "border-red-800 text-red-400 bg-red-950/30"
                        : q.status === "countered"
                        ? "border-purple-800 text-purple-400 bg-purple-950/30"
                        : "border-slate-700 text-slate-400 bg-slate-800"
                    }`}
                  >
                    {q.status.charAt(0).toUpperCase() + q.status.slice(1)}
                  </span>
                </div>

                {(isPending || isCountered) && request.status !== "accepted" && (
                  <div className="space-y-2 border-t border-slate-800 pt-3">
                    {isPending && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          disabled={!!acting}
                          onClick={() => act("accept", q.id)}
                          className="inline-flex items-center gap-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                        >
                          <CheckCircle className="h-3.5 w-3.5" />
                          {busy("accept") ? "..." : "Accept"}
                        </button>
                        <button
                          disabled={!!acting}
                          onClick={() => act("reject", q.id)}
                          className="inline-flex items-center gap-1.5 border border-red-800 text-red-400 hover:bg-red-950/30 disabled:opacity-50 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          {busy("reject") ? "..." : "Reject"}
                        </button>
                        <div className="flex items-center gap-1.5 ml-auto">
                          <input
                            type="number"
                            placeholder="Counter $"
                            value={cp}
                            onChange={(e) =>
                              setCounterPrice((c) => ({ ...c, [q.id]: e.target.value }))
                            }
                            className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-1 focus:ring-orange-600"
                          />
                          <button
                            disabled={!cp || !!acting}
                            onClick={() => act("counter", q.id, { counterPrice: parseFloat(cp) })}
                            className="inline-flex items-center gap-1.5 border border-purple-800 text-purple-400 hover:bg-purple-950/30 disabled:opacity-50 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                            {busy("counter") ? "..." : "Counter"}
                          </button>
                        </div>
                      </div>
                    )}
                    {isCountered && (
                      <p className="text-xs text-slate-400">
                        Waiting for operator to respond to your counter offer of $
                        {Number(q.counterOffer).toFixed(2)}.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {quotes.length === 0 && (
        <div className="text-center py-10 text-slate-400 text-sm">
          No quotes yet. Operators will submit quotes shortly.
        </div>
      )}
    </div>
  );
}
