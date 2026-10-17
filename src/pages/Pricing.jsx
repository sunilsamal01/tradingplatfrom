import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Sparkles, ArrowRight, RefreshCw } from "lucide-react";
import { Container, Section, SectionHeading, Button, Badge } from "../components/ui.jsx";
import { useAuth } from "../context/useAuth.js";
import { fetchPublishedPlans, formatPlanPrice, intervalLabel } from "../lib/plans.js";
import { cn } from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Public pricing page. Every plan name, price, feature and badge is loaded
// from the backend Plan catalogue — nothing is hardcoded here. Loading, empty
// and error states are all handled explicitly.
//
// Choosing a plan routes into the unified checkout (/checkout?plan=<slug>),
// where the authoritative price is resolved again on the server.
// ---------------------------------------------------------------------------
export default function Pricing() {
  const [plans, setPlans] = useState(null); // null = loading
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { user } = useAuth();
  const reduce = useReducedMotion();

  const load = () => {
    setError("");
    fetchPublishedPlans()
      .then((p) => setPlans(Array.isArray(p) ? p : []))
      .catch((e) => { setError(e?.message || "Couldn't load pricing"); setPlans([]); });
  };
  useEffect(() => { load(); }, []);

  const ordered = useMemo(() => [...(plans || [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)), [plans]);

  // Card entrance: staggered, and skipped entirely under reduced-motion.
  const cardAnim = (i) => (reduce ? {} : {
    initial: { opacity: 0, y: 22 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.45, delay: Math.min(i * 0.07, 0.35), ease: [0.22, 1, 0.36, 1] },
  });

  const onChoose = (plan) => {
    if (!user) { navigate("/register"); return; }
    navigate(`/checkout?plan=${encodeURIComponent(plan.slug || plan.id || "")}`);
  };

  return (
    <Section className="relative overflow-hidden">
      {/* Restrained backdrop — a single soft glow, not a gradient storm. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(34,211,238,0.10),transparent)]" />
      <Container className="relative">
        <SectionHeading
          eyebrow="PRICING"
          title="Plans that scale with your edge"
          desc="Four tiers, billed monthly in USD. Upgrade, downgrade or cancel anytime — your data and history always follow you."
          className="mx-auto max-w-2xl text-center [&>p]:mx-auto"
        />

        {/* Loading skeletons */}
        {plans === null && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-[420px] rounded-2xl" />
            ))}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="mx-auto max-w-md rounded-2xl border border-rose-500/25 bg-rose-500/5 p-6 text-center" role="alert">
            <p className="text-sm font-medium text-white">Couldn't load pricing</p>
            <p className="mt-1 text-xs text-white/50">{error}</p>
            <Button variant="secondary" size="sm" className="mt-4" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          </div>
        )}

        {/* Empty state */}
        {!error && plans && ordered.length === 0 && (
          <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
            <p className="text-sm font-medium text-white">No plans published yet</p>
            <p className="mt-1 text-xs text-white/50">Our team is configuring pricing. Check back shortly.</p>
          </div>
        )}

        {/* Plan cards */}
        {ordered.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ordered.map((plan, i) => (
              <PlanCard key={plan.id || plan.slug} plan={plan} anim={cardAnim(i)} onChoose={onChoose} currentPlan={user?.plan} />
            ))}
          </div>
        )}

        <p className="mx-auto mt-8 max-w-2xl text-center text-xs text-white/40">
          All prices in USD, taxes where applicable excluded. Payments are processed securely by our payment partners — card details are never stored on our servers.
        </p>
      </Container>
    </Section>
  );
}

function PlanCard({ plan, anim, onChoose, currentPlan }) {
  const { display } = formatPlanPrice(plan);
  const featured = !!plan.recommended;
  const isCurrent = currentPlan && String(currentPlan).toLowerCase() === String(plan.slug).toLowerCase();

  return (
    <motion.div
      {...anim}
      className={cn(
        "relative flex flex-col rounded-2xl border p-5 transition-colors",
        featured
          ? "border-cyan-400/50 bg-cyan-400/[0.04] shadow-[0_0_0_1px_rgba(34,211,238,0.15),0_18px_50px_-20px_rgba(34,211,238,0.35)]"
          : "border-white/10 bg-white/[0.02] hover:border-white/20",
      )}
    >
      {featured && (
        <span className="absolute -top-2.5 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">
          <Sparkles className="h-3 w-3" aria-hidden />
          {plan.badge || "Recommended"}
        </span>
      )}

      <header className="min-h-[3.25rem]">
        <h3 className={cn("font-display text-base font-bold", featured ? "text-cyan-200" : "text-white")}>{plan.name}</h3>
        {plan.blurb && <p className="mt-1 text-xs leading-relaxed text-white/50">{plan.blurb}</p>}
      </header>

      <div className="mt-4 flex items-baseline gap-1">
        <span className={cn("num text-3xl font-bold tracking-tight", featured ? "text-white" : "text-white")}>{display}</span>
        <span className="text-xs text-white/40">{intervalLabel(plan)}</span>
      </div>

      <ul className="mt-5 flex flex-1 flex-col gap-2.5">
        {(plan.features || []).map((f) => (
          <li key={f} className="flex items-start gap-2 text-xs leading-relaxed text-white/70">
            <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", featured ? "text-cyan-300" : "text-emerald-400")} aria-hidden />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {isCurrent ? (
          <Badge tone="success" className="w-full justify-center py-2">Your current plan</Badge>
        ) : (
          <Button
            variant={featured ? "primary" : "secondary"}
            className="w-full"
            onClick={() => onChoose(plan)}
          >
            {plan.cta || "Choose plan"} <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
      </div>
    </motion.div>
  );
}
