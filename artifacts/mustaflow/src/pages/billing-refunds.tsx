import { CalendarClock, CreditCard, ReceiptText, RefreshCcw, WalletCards } from "lucide-react";
import { Link } from "wouter";
import { LegalContact, LegalLayout, LegalSection } from "@/components/legal/legal-layout";

export default function BillingRefundsPage() {
  return (
    <LegalLayout
      title="Billing & Refund Policy"
      description="How NabuFlow subscriptions, upgrades, downgrades, overage, cancellation, and refunds work."
      path="/billing-refunds"
      icon={ReceiptText}
      introduction={
        <>
          <p>
            This Policy describes the shipped billing behavior for NabuFlow subscriptions provided
            by MustaFlow AI Technology LLC.
          </p>
          <p>
            Current plan prices, included credits, and overage rates appear on the{" "}
            <Link href="/pricing" className="font-medium text-primary hover:underline">
              live pricing page
            </Link>
            , which is the source of truth for amounts.
          </p>
        </>
      }
    >
      <LegalSection number={1} title="Subscriptions and renewals" icon={CalendarClock}>
        <p>
          A paid plan starts after payment succeeds and renews for another billing cycle unless you
          cancel. At renewal, the plan's included-credit bucket and metered build counters reset
          according to that plan.
        </p>
      </LegalSection>

      <LegalSection number={2} title="Upgrades start and charge now" icon={CreditCard}>
        <p>
          An upgrade takes effect immediately. Stripe charges a prorated amount for the unused time
          on your current plan and the new plan for the rest of the current cycle. The confirmation
          separates the amount due now from the next full monthly charge and its start date.
        </p>
        <p>
          The upgrade invoice also includes any overage usage from the current cycle that has not
          been billed yet. Because that usage is swept into the invoice by Stripe, the final charged
          total can be slightly higher than the plan-change preview. Your new plan and its credits
          begin only after the immediate payment succeeds.
        </p>
      </LegalSection>

      <LegalSection number={3} title="Downgrades take effect at renewal" icon={CalendarClock}>
        <p>
          A downgrade is scheduled for the end of your current paid period. Nothing is charged at
          the time you schedule it, and scheduling it does not create a refund, account credit, or
          credit note. You keep your current plan, credits, and engine access until the renewal
          date; the lower plan and its price begin then.
        </p>
        <p>
          A pending downgrade is shown in Billing &amp; Usage. Reaffirming or replacing the pending
          downgrade updates the scheduled change, and upgrading before renewal cancels the pending
          downgrade before the upgrade is processed.
        </p>
      </LegalSection>

      <LegalSection number={4} title="Cancellation, resuming, and refunds" icon={RefreshCcw}>
        <p>
          Cancellation takes effect at the end of the current paid period. You retain plan access
          through that date and may resume before the cancellation takes effect. We do not provide
          partial-cycle refunds for unused time, credits, or access.
        </p>
        <p>
          This no-partial-refund rule does not limit rights that cannot be waived under applicable
          law. If you believe a charge was made in error, contact us with the relevant invoice or
          payment details.
        </p>
      </LegalSection>

      <LegalSection number={5} title="Included credits and rollover" icon={WalletCards}>
        <p>
          Each renewal grants the included-credit bucket for the plan active at that renewal. Unused
          included credits roll into the next cycle on Comet and Nova only, subject to the plan's
          rollover cap. Orbit credits never roll over. Metered build allowances and counters do not
          roll over.
        </p>
      </LegalSection>

      <LegalSection number={6} title="Overage and spending limits" icon={ReceiptText}>
        <p>
          When included credits run out, builds continue and extra credits are billed at the active
          plan's overage rate. Overage is recorded during the cycle and may be billed on an upgrade
          invoice or the cycle's Stripe invoice.
        </p>
        <p>
          Your monthly spending limit caps new overage. Once the limit is reached, the next build is
          paused before it starts; a build already running is not stopped mid-run. You can review or
          change the allowed limit in Billing &amp; Usage, within the plan's permitted range.
        </p>
      </LegalSection>

      <LegalSection number={7} title="Questions about a charge">
        <p>
          Billing questions may be sent to <LegalContact subject="Billing question" />. Include the
          invoice date and a description of the issue, but do not send full card details.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
