import { Link } from "react-router-dom";
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
          <p className="text-slate-400 mt-1 text-sm">
            Browse open requests and submit quotes from the operator dashboard.
          </p>
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
