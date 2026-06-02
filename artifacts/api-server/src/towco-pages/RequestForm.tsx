import { useState, useEffect } from "react";
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

function InputField({
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
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-600 text-sm"
      />
    </div>
  );
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
            email: `customer-${Date.now()}@towco.local`,
          }),
        });
        if (!cRes.ok) throw new Error("Failed to create customer");
        const c: Customer = await cRes.json();
        customerId = c.id;
      }
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, customerId }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || "Request failed");
      }
      const req = (await res.json()) as { id: string };
      navigate(`/request/${req.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10">
      <div className="mb-8 space-y-1">
        <div className="flex items-center gap-2 text-orange-500 text-sm font-medium">
          <Truck className="h-4 w-4" />
          New Request
        </div>
        <h1 className="text-2xl font-bold text-white">Request a Tow</h1>
        <p className="text-slate-400 text-sm">
          Fill in the details and operators will submit quotes.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Customer */}
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
                className={`text-sm px-3 py-1.5 rounded-md border transition-colors ${useExisting ? "border-orange-600 text-orange-400 bg-orange-950/30" : "border-slate-700 text-slate-400"}`}
              >
                Existing customer
              </button>
              <button
                type="button"
                onClick={() => setUseExisting(false)}
                className={`text-sm px-3 py-1.5 rounded-md border transition-colors ${!useExisting ? "border-orange-600 text-orange-400 bg-orange-950/30" : "border-slate-700 text-slate-400"}`}
              >
                New customer
              </button>
            </div>
          )}
          {useExisting && customers.length > 0 ? (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                Select Customer
              </label>
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
              <InputField
                label="Name"
                value={form.customerName}
                onChange={(v) => setForm((f) => ({ ...f, customerName: v }))}
                placeholder="Jane Smith"
              />
              <InputField
                label="Phone"
                value={form.customerPhone}
                onChange={(v) => setForm((f) => ({ ...f, customerPhone: v }))}
                placeholder="+1 555 000 0000"
              />
            </div>
          )}
        </section>

        {/* Locations */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <MapPin className="h-4 w-4 text-slate-500" />
            Locations
          </div>
          <InputField
            label="Pickup Address"
            value={form.pickupAddress}
            onChange={(v) => setForm((f) => ({ ...f, pickupAddress: v }))}
            placeholder="123 Main St, City, State"
          />
          <InputField
            label="Dropoff Address"
            value={form.dropoffAddress}
            onChange={(v) => setForm((f) => ({ ...f, dropoffAddress: v }))}
            placeholder="456 Elm Ave, City, State"
          />
        </section>

        {/* Vehicle */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Car className="h-4 w-4 text-slate-500" />
            Vehicle
          </div>
          <div className="grid grid-cols-3 gap-3">
            <InputField
              label="Make"
              value={form.vehicleMake}
              onChange={(v) => setForm((f) => ({ ...f, vehicleMake: v }))}
              placeholder="Toyota"
            />
            <InputField
              label="Model"
              value={form.vehicleModel}
              onChange={(v) => setForm((f) => ({ ...f, vehicleModel: v }))}
              placeholder="Camry"
            />
            <InputField
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
