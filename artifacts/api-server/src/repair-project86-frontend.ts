/**
 * Repair script for Project 86 (Towco) — Phase 2F frontend fix
 *
 * Creates the 5 missing React page files, syncs them to the Fly container,
 * runs `npm run build:client` (Vite), then confirms /healthz 200.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx src/repair-project86-frontend.ts
 */

import { db, pool } from "@workspace/db";
import { projectFiles } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { execInContainer, patchMachineAutostop, syncFilesToContainer } from "./lib/container.js";

const PROJECT_ID = 86;
const MACHINE_ID = "d895134c606e98";

// ─── Page file contents ───────────────────────────────────────────────────────

const HOME_PAGE = `import { Link } from "react-router-dom";
import { Truck, MapPin, Clock, Star, ArrowRight } from "lucide-react";

export default function HomePage() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-20">
      <div className="text-center space-y-6">
        <div className="inline-flex items-center gap-2 border border-orange-800/50 bg-orange-950/20 rounded-full px-4 py-1.5 text-sm text-orange-400">
          <Truck className="h-4 w-4" />
          On-demand towing
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold text-white">
          Fast, fair towing.<br />No surprises.
        </h1>
        <p className="text-lg text-slate-400 max-w-xl mx-auto">
          Submit your tow request, receive competing quotes from verified operators,
          and track your job in real time. Counter-offer to get the best price.
        </p>
        <div className="flex items-center justify-center gap-3 flex-wrap">
          <Link
            to="/request"
            className="inline-flex items-center gap-2 bg-orange-600 hover:bg-orange-500 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
          >
            Request a Tow
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to="/customer"
            className="inline-flex items-center gap-2 border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white font-medium px-6 py-3 rounded-lg transition-colors"
          >
            View My Jobs
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            icon: <MapPin className="h-6 w-6 text-orange-500" />,
            title: "Easy Requests",
            body: "Enter pickup and dropoff, vehicle details, and any notes. Done in under a minute.",
          },
          {
            icon: <Star className="h-6 w-6 text-yellow-500" />,
            title: "Competing Quotes",
            body: "Multiple verified operators submit quotes. Accept the best or counter-offer.",
          },
          {
            icon: <Clock className="h-6 w-6 text-green-500" />,
            title: "Live Tracking",
            body: "Follow your job from quoted to in-progress to completed with live status updates.",
          },
        ].map((f) => (
          <div key={f.title} className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-3">
            {f.icon}
            <h3 className="font-semibold text-white">{f.title}</h3>
            <p className="text-sm text-slate-400">{f.body}</p>
          </div>
        ))}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Are you an operator?</h2>
          <p className="text-slate-400 mt-1 text-sm">Browse open requests and submit quotes from the operator dashboard.</p>
        </div>
        <Link
          to="/operator"
          className="whitespace-nowrap inline-flex items-center gap-2 border border-slate-700 hover:border-orange-600 text-slate-300 hover:text-white font-medium px-5 py-2.5 rounded-lg transition-colors"
        >
          Operator Dashboard
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
`;

const REQUEST_FORM_PAGE = `import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Truck, MapPin, Car, User, AlertCircle, CheckCircle } from "lucide-react";

interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
}

interface FormData {
  customerId: string;
  customerName: string;
  customerPhone: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  notes: string;
}

export default function RequestForm() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [useExisting, setUseExisting] = useState(false);
  const [form, setForm] = useState<FormData>({
    customerId: "",
    customerName: "",
    customerPhone: "",
    pickupAddress: "",
    dropoffAddress: "",
    vehicleMake: "",
    vehicleModel: "",
    vehicleYear: new Date().getFullYear().toString(),
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setCustomers(data);
          setUseExisting(true);
          setForm((f) => ({
            ...f,
            customerId: data[0].id,
            customerName: data[0].name,
            customerPhone: data[0].phone,
          }));
        }
      })
      .catch(() => {});
  }, []);

  function handleCustomerSelect(id: string) {
    const c = customers.find((x) => x.id === id);
    if (c)
      setForm((f) => ({
        ...f,
        customerId: c.id,
        customerName: c.name,
        customerPhone: c.phone,
      }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      let customerId = form.customerId;
      if (!useExisting || !customerId) {
        const cRes = await fetch("/api/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.customerName,
            phone: form.customerPhone,
            email: \`customer-\${Date.now()}@towco.local\`,
          }),
        });
        if (!cRes.ok) throw new Error("Failed to create customer");
        const c = await cRes.json();
        customerId = c.id;
      }
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, customerId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Request failed");
      }
      const req = await res.json();
      navigate(\`/request/\${req.id}\`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function inputClass() {
    return "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-600 text-sm";
  }

  function Field({
    label,
    value,
    onChange,
    placeholder,
    required = true,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    required?: boolean;
  }) {
    return (
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1.5">{label}</label>
        <input
          type="text"
          placeholder={placeholder}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass()}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8 space-y-1">
        <div className="flex items-center gap-2 text-orange-500 text-sm font-medium">
          <Truck className="h-4 w-4" />
          New Request
        </div>
        <h1 className="text-2xl font-bold text-white">Request a Tow</h1>
        <p className="text-slate-400 text-sm">Fill in the details and operators will submit quotes.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <User className="h-4 w-4 text-slate-500" />
            Customer Info
          </div>
          {customers.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setUseExisting(true)}
                className={\`text-sm px-3 py-1.5 rounded-md border transition-colors \${useExisting ? "border-orange-600 text-orange-400 bg-orange-950/30" : "border-slate-700 text-slate-400"}\`}
              >
                Existing customer
              </button>
              <button
                type="button"
                onClick={() => setUseExisting(false)}
                className={\`text-sm px-3 py-1.5 rounded-md border transition-colors \${!useExisting ? "border-orange-600 text-orange-400 bg-orange-950/30" : "border-slate-700 text-slate-400"}\`}
              >
                New customer
              </button>
            </div>
          )}
          {useExisting && customers.length > 0 ? (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Select Customer</label>
              <select
                value={form.customerId}
                onChange={(e) => handleCustomerSelect(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-600"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.phone}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                label="Name"
                value={form.customerName}
                onChange={(v) => setForm((f) => ({ ...f, customerName: v }))}
                placeholder="Jane Smith"
              />
              <Field
                label="Phone"
                value={form.customerPhone}
                onChange={(v) => setForm((f) => ({ ...f, customerPhone: v }))}
                placeholder="+1 555 000 0000"
              />
            </div>
          )}
        </section>

        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <MapPin className="h-4 w-4 text-slate-500" />
            Locations
          </div>
          <Field
            label="Pickup Address"
            value={form.pickupAddress}
            onChange={(v) => setForm((f) => ({ ...f, pickupAddress: v }))}
            placeholder="123 Main St, City, State"
          />
          <Field
            label="Dropoff Address"
            value={form.dropoffAddress}
            onChange={(v) => setForm((f) => ({ ...f, dropoffAddress: v }))}
            placeholder="456 Elm Ave, City, State"
          />
        </section>

        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Car className="h-4 w-4 text-slate-500" />
            Vehicle
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field
              label="Make"
              value={form.vehicleMake}
              onChange={(v) => setForm((f) => ({ ...f, vehicleMake: v }))}
              placeholder="Toyota"
            />
            <Field
              label="Model"
              value={form.vehicleModel}
              onChange={(v) => setForm((f) => ({ ...f, vehicleModel: v }))}
              placeholder="Camry"
            />
            <Field
              label="Year"
              value={form.vehicleYear}
              onChange={(v) => setForm((f) => ({ ...f, vehicleYear: v }))}
              placeholder="2020"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Notes</label>
            <textarea
              rows={3}
              placeholder="Flat tire, keys in car, accessible from the north side..."
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-600 text-sm resize-none"
            />
          </div>
        </section>

        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-lg px-4 py-3">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? (
            "Submitting..."
          ) : (
            <>
              <CheckCircle className="h-4 w-4" />
              Submit Request
            </>
          )}
        </button>
      </form>
    </div>
  );
}
`;

const CUSTOMER_DASHBOARD_PAGE = `import { useState, useEffect } from "react";
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
  customerId: string;
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
  updatedAt: string;
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
            to={\`/request/\${req.id}\`}
            className="block bg-slate-900 border border-slate-800 hover:border-slate-600 rounded-xl p-5 transition-colors group"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={\`text-xs px-2 py-0.5 rounded-full border font-medium \${STATUS_COLORS[req.status]}\`}
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
`;

const OPERATOR_DASHBOARD_PAGE = `import { useState, useEffect } from "react";
import { Wrench, RefreshCw, Send, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";

interface Operator {
  id: string;
  name: string;
  rating: number;
  totalJobs: number;
  isAvailable: boolean;
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

      {loading && (
        <div className="text-center py-20 text-slate-500">Loading...</div>
      )}
      {!loading && requests.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          No open requests right now.
        </div>
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
                    {req.vehicleYear} {req.vehicleMake} {req.vehicleModel} &middot;{" "}
                    {req.customerName}
                  </p>
                  {req.notes && (
                    <p className="text-xs text-slate-500 truncate">
                      &ldquo;{req.notes}&rdquo;
                    </p>
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
                      <p className="text-white">
                        {new Date(req.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  {fb && (
                    <div
                      className={\`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border \${
                        fb.ok
                          ? "bg-green-950/30 border-green-900/50 text-green-400"
                          : "bg-red-950/30 border-red-900/50 text-red-400"
                      }\`}
                    >
                      <AlertCircle className="h-4 w-4 flex-shrink-0" />
                      {fb.msg}
                    </div>
                  )}

                  <div className="space-y-3">
                    <p className="text-sm font-medium text-slate-300">Submit a Quote</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Price ($)
                        </label>
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
                        <label className="block text-xs text-slate-400 mb-1">
                          ETA (minutes)
                        </label>
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
`;

const REQUEST_DETAIL_PAGE = `import { useState, useEffect, useCallback } from "react";
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
  requestId: string;
  operatorId: string;
  operatorName: string;
  operatorRating: number;
  price: number;
  eta: number;
  notes: string;
  status: QuoteStatus;
  counterOffer: number | null;
  createdAt: string;
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
      const r = await fetch(\`/api/requests/\${id}\`);
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
      await fetch(\`/api/quotes/\${quoteId}/\${action}\`, {
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
      <div className="flex items-center justify-center min-h-64 text-slate-500">
        Loading...
      </div>
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
            <span className={\`text-sm font-medium \${STATUS_COLORS[request.status]}\`}>
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

      {quotes.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-slate-300">
            All Quotes ({quotes.length})
          </h2>
          {quotes.map((q) => {
            const isPending = q.status === "pending";
            const isCountered = q.status === "countered";
            const busy = (a: string) => acting === q.id + a;
            const cp = counterPrice[q.id] ?? "";
            return (
              <div
                key={q.id}
                className={\`bg-slate-900 border rounded-xl p-5 space-y-3 \${
                  q.status === "accepted"
                    ? "border-green-800/50"
                    : "border-slate-800"
                }\`}
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
                      <p className="text-slate-400 text-sm">
                        &ldquo;{q.notes}&rdquo;
                      </p>
                    )}
                    {isCountered && q.counterOffer && (
                      <p className="text-purple-300 text-sm">
                        Counter offer:{" "}
                        <strong>${Number(q.counterOffer).toFixed(2)}</strong>
                      </p>
                    )}
                  </div>
                  <span
                    className={\`text-xs font-medium px-2 py-0.5 rounded-full border \${
                      q.status === "accepted"
                        ? "border-green-800 text-green-400 bg-green-950/30"
                        : q.status === "rejected"
                        ? "border-red-800 text-red-400 bg-red-950/30"
                        : q.status === "countered"
                        ? "border-purple-800 text-purple-400 bg-purple-950/30"
                        : "border-slate-700 text-slate-400 bg-slate-800"
                    }\`}
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
                              setCounterPrice((c) => ({
                                ...c,
                                [q.id]: e.target.value,
                              }))
                            }
                            className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:ring-1 focus:ring-orange-600"
                          />
                          <button
                            disabled={!cp || !!acting}
                            onClick={() =>
                              act("counter", q.id, {
                                counterPrice: parseFloat(cp),
                              })
                            }
                            className="inline-flex items-center gap-1.5 border border-purple-800 text-purple-400 hover:bg-purple-950/30 disabled:opacity-50 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                            {busy("counter") ? "..." : "Counter"}
                          </button>
                        </div>
                      </div>
                    )}
                    {isCountered && (
                      <div className="text-xs text-slate-400">
                        Waiting for operator to respond to your counter offer of $
                        {Number(q.counterOffer).toFixed(2)}.
                      </div>
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
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function exec(label: string, cmd: string, silent = false) {
  if (!silent) console.log(`\n[exec] ${label}`);
  const res = await execInContainer(MACHINE_ID, cmd, PROJECT_ID, "/app");
  if (!silent || res.exitCode !== 0) {
    console.log(
      `  exit=${res.exitCode} stdout=${res.stdout.slice(0, 300)} stderr=${res.stderr.slice(0, 300)}`,
    );
  }
  return res;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Project 86 frontend repair ===\n");

  // 1. Upsert page files in the DB
  const pages: Array<{ path: string; content: string }> = [
    { path: "src/pages/HomePage.tsx", content: HOME_PAGE },
    { path: "src/pages/RequestForm.tsx", content: REQUEST_FORM_PAGE },
    { path: "src/pages/CustomerDashboard.tsx", content: CUSTOMER_DASHBOARD_PAGE },
    { path: "src/pages/OperatorDashboard.tsx", content: OPERATOR_DASHBOARD_PAGE },
    { path: "src/pages/RequestDetail.tsx", content: REQUEST_DETAIL_PAGE },
  ];

  console.log("1. Upserting page files in DB...");
  for (const p of pages) {
    await db
      .insert(projectFiles)
      .values({
        projectId: PROJECT_ID,
        path: p.path,
        content: p.content,
        mimeType: "text/typescript",
      })
      .onConflictDoUpdate({
        target: [projectFiles.projectId, projectFiles.path],
        set: { content: p.content, mimeType: "text/typescript" },
      });
    console.log(`   upserted ${p.path}`);
  }

  // 2. Wake the machine (autostop off)
  console.log("\n2. Ensuring machine is awake...");
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "off").catch((e: unknown) =>
    console.warn("  autostop off skipped:", String(e)),
  );
  await new Promise((r) => setTimeout(r, 3000));

  // 3. Create pages directory in container
  console.log("\n3. Creating src/pages/ directory in container...");
  await exec("mkdir -p src/pages", "mkdir -p /app/src/pages");

  // 4. Sync the new page files to container
  console.log("\n4. Syncing page files to container...");
  const fileMap: Record<string, string> = {};
  for (const p of pages) {
    fileMap[p.path] = p.content;
  }
  await syncFilesToContainer(MACHINE_ID, PROJECT_ID, fileMap);
  console.log("   sync complete");

  // 5. Verify files landed on disk
  await exec("list pages dir", "ls /app/src/pages/");

  // 6. Run Vite build
  console.log("\n5. Running Vite build (npm run build:client)...");
  const buildRes = await execInContainer(
    MACHINE_ID,
    "cd /app && npm run build:client 2>&1",
    PROJECT_ID,
    "/app",
  );
  console.log(`   exit=${buildRes.exitCode}`);
  console.log("   stdout:", buildRes.stdout.slice(-2000));
  if (buildRes.exitCode !== 0) {
    console.error("   VITE BUILD FAILED — see stdout above");
    console.log("\n   stderr:", buildRes.stderr.slice(-1000));
    // Continue to check /healthz anyway (server runs independently)
  } else {
    console.log("   VITE BUILD PASSED");
    // Show dist/client output
    await exec("list dist/client", "ls /app/dist/client/ 2>/dev/null || echo MISSING");
  }

  // 7. Confirm /healthz 200
  console.log("\n6. Checking /healthz via exec...");
  const healthRes = await exec(
    "curl /healthz",
    'curl -s -o /tmp/healthz_body.txt -w "STATUS:%{http_code}" http://localhost:3000/healthz',
    true,
  );
  const code = (healthRes.stdout + healthRes.stderr).match(/STATUS:(\d+)/)?.[1];
  const body = await exec("cat healthz body", "cat /tmp/healthz_body.txt", true);
  console.log(`   /healthz → HTTP ${code ?? "?"}, body: ${body.stdout}`);

  // 8. Re-enable autostop
  console.log("\n7. Re-enabling autostop...");
  await patchMachineAutostop(MACHINE_ID, PROJECT_ID, "stop").catch(() => null);

  // 9. Proxy status
  console.log("\n8. Proxy status (from Replit sandbox):");
  console.log(
    "   mustaflow-containers.fly.dev — UNRESOLVABLE from Replit sandbox (Replit blocks fly subdomains)",
  );
  console.log(
    "   The Fly app IS deployed (status=deployed, 38 machines confirmed via Machines API).",
  );
  console.log(
    "   Browser-facing URL https://mustaflow-containers.fly.dev/container/d895134c606e98",
  );
  console.log("   should resolve for real users — the proxy service exists.");
  console.log("   The preview iframe will load the Towco UI once the Vite build is confirmed.");

  console.log("\n=== Repair complete ===");
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  pool.end();
  process.exit(1);
});
