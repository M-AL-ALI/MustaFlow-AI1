import { useState, useEffect } from "react";
import { Wrench, RefreshCw, Send, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";

interface Operator {
  id: string;
  name: string;
  rating: number;
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
  status: string;
  createdAt: string;
}

interface QuoteForm {
  price: string;
  eta: string;
  notes: string;
}

export default function OperatorDashboard() {
  const [operators, setOperators] = useState<Operator[]>([]);
  const [selectedOp, setSelectedOp] = useState<string>("");
  const [requests, setRequests] = useState<TowRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [quoteForm, setQuoteForm] = useState<Record<string, QuoteForm>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; msg: string }>>({});

  useEffect(() => {
    fetch("/api/operators")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setOperators(data);
          if (data[0]) setSelectedOp(data[0].id);
        }
      })
      .catch(() => {});
  }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/requests");
      if (!r.ok) throw new Error();
      const all: TowRequest[] = await r.json();
      setRequests(
        all.filter(
          (req) =>
            req.status === "pending" ||
            req.status === "quoted" ||
            req.status === "counter_offered"
        )
      );
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function getForm(id: string): QuoteForm {
    return quoteForm[id] ?? { price: "", eta: "", notes: "" };
  }

  function setFormField(id: string, key: keyof QuoteForm, value: string) {
    setQuoteForm((f) => ({ ...f, [id]: { ...getForm(id), [key]: value } }));
  }

  async function submitQuote(req: TowRequest) {
    const f = getForm(req.id);
    if (!f.price || !f.eta || !selectedOp) return;
    setSubmitting(req.id);
    try {
      const res = await fetch("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: req.id,
          operatorId: selectedOp,
          price: parseFloat(f.price),
          eta: parseInt(f.eta, 10),
          notes: f.notes,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      setFeedback((fb) => ({ ...fb, [req.id]: { ok: true, msg: "Quote submitted!" } }));
      setQuoteForm((f2) => ({ ...f2, [req.id]: { price: "", eta: "", notes: "" } }));
      await load();
    } catch {
      setFeedback((fb) => ({
        ...fb,
        [req.id]: { ok: false, msg: "Failed to submit quote." },
      }));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
      <div className="flex items-center justify-between mb-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-orange-500 text-sm font-medium">
            <Wrench className="h-4 w-4" />
            Operator Dashboard
          </div>
          <h1 className="text-2xl font-bold text-white">Open Requests</h1>
        </div>
        <button
          onClick={load}
          className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {operators.length > 0 && (
        <div className="mb-6">
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Quoting as operator
          </label>
          <select
            value={selectedOp}
            onChange={(e) => setSelectedOp(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-600"
          >
            {operators.map((op) => (
              <option key={op.id} value={op.id}>
                {op.name} &#9733; {Number(op.rating).toFixed(1)}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && <div className="text-center py-20 text-slate-500">Loading...</div>}
      {!loading && requests.length === 0 && (
        <div className="text-center py-20 text-slate-400">No open requests right now.</div>
      )}

      <div className="space-y-3">
        {requests.map((req) => {
          const isOpen = expandedId === req.id;
          const f = getForm(req.id);
          const fb = feedback[req.id];
          return (
            <div
              key={req.id}
              className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden"
            >
              <button
                type="button"
                className="w-full text-left px-5 py-4 flex items-start justify-between gap-4 hover:bg-slate-800/50 transition-colors"
                onClick={() => setExpandedId(isOpen ? null : req.id)}
              >
                <div className="space-y-1 min-w-0">
                  <p className="text-white font-medium truncate">
                    {req.pickupAddress} &rarr; {req.dropoffAddress}
                  </p>
                  <p className="text-sm text-slate-400">
                    {req.vehicleYear} {req.vehicleMake} {req.vehicleModel} &middot; {req.customerName}
                  </p>
                  {req.notes && (
                    <p className="text-xs text-slate-500 truncate">&ldquo;{req.notes}&rdquo;</p>
                  )}
                </div>
                {isOpen ? (
                  <ChevronUp className="h-4 w-4 text-slate-500 flex-shrink-0 mt-0.5" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-slate-500 flex-shrink-0 mt-0.5" />
                )}
              </button>

              {isOpen && (
                <div className="px-5 pb-5 border-t border-slate-800 pt-4 space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-slate-500">Customer</span>
                      <p className="text-white">
                        {req.customerName} &middot; {req.customerPhone}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-500">Requested</span>
                      <p className="text-white">{new Date(req.createdAt).toLocaleString()}</p>
                    </div>
                  </div>

                  {fb && (
                    <div
                      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${
                        fb.ok
                          ? "bg-green-950/30 border-green-900/50 text-green-400"
                          : "bg-red-950/30 border-red-900/50 text-red-400"
                      }`}
                    >
                      <AlertCircle className="h-4 w-4 flex-shrink-0" />
                      {fb.msg}
                    </div>
                  )}

                  <div className="space-y-3">
                    <p className="text-sm font-medium text-slate-300">Submit a Quote</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Price ($)</label>
                        <input
                          type="number"
                          min="1"
                          placeholder="150"
                          value={f.price}
                          onChange={(e) => setFormField(req.id, "price", e.target.value)}
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">ETA (minutes)</label>
                        <input
                          type="number"
                          min="5"
                          placeholder="25"
                          value={f.eta}
                          onChange={(e) => setFormField(req.id, "eta", e.target.value)}
                          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-600"
                        />
                      </div>
                    </div>
                    <input
                      type="text"
                      placeholder="Notes (optional)"
                      value={f.notes}
                      onChange={(e) => setFormField(req.id, "notes", e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-orange-600"
                    />
                    <button
                      type="button"
                      disabled={!f.price || !f.eta || submitting === req.id}
                      onClick={() => submitQuote(req)}
                      className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {submitting === req.id ? "Sending..." : "Submit Quote"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
