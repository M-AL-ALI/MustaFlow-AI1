import { AlertTriangle, FileCode2, Scale, ShieldCheck, WalletCards } from "lucide-react";
import { Link } from "wouter";
import { LegalContact, LegalLayout, LegalSection } from "@/components/legal/legal-layout";

export default function TermsPage() {
  return (
    <LegalLayout
      title="Terms of Service"
      description="Terms governing your use of MustaFlow AI, NabuFlow, Ora, and Orax."
      path="/terms"
      icon={Scale}
      introduction={
        <>
          <p>
            These Terms of Service govern your use of the products and services operated by
            MustaFlow AI Technology LLC, a North Carolina limited liability company ("MustaFlow AI,"
            "we," "us," or "our").
          </p>
          <p>By using the services, you agree to these Terms.</p>
        </>
      }
    >
      <LegalSection number={1} title="The services" icon={FileCode2}>
        <p>
          MustaFlow AI provides NabuFlow, an AI app builder that generates and deploys user
          projects, together with Ora, Orax, and related project, collaboration, publishing, and
          support features (collectively, the "Services"). Features may change as we improve the
          Services.
        </p>
      </LegalSection>

      <LegalSection number={2} title="Accounts and authority" icon={ShieldCheck}>
        <p>
          You must provide accurate account information, protect your sign-in credentials, and
          promptly tell us about suspected unauthorized access. If you use the Services for an
          organization, you represent that you have authority to accept these Terms for it.
        </p>
        <p>You are responsible for activity performed through your account and projects.</p>
      </LegalSection>

      <LegalSection number={3} title="Your projects and content" icon={FileCode2}>
        <p>
          As between you and MustaFlow AI, you own your project code and content, including code and
          content generated into your project, as well as the prompts, files, and data you provide.
          MustaFlow AI does not claim ownership of that project material. You grant us the limited
          rights needed to host, copy, process, transmit, display, and modify it solely to operate,
          secure, support, and improve the Services for you.
        </p>
        <p>
          You must have the rights needed for content you submit, including data, software,
          trademarks, images, and other third-party materials. You are responsible for your deployed
          applications and for complying with laws and third-party terms that apply to them.
        </p>
      </LegalSection>

      <LegalSection number={4} title="AI-generated output" icon={AlertTriangle}>
        <p>
          AI-generated output may be inaccurate, incomplete, insecure, or similar to output made for
          someone else. You must review and test output before relying on, publishing, or deploying
          it.
        </p>
        <p>
          AI-generated output is provided as-is, without a warranty that it is accurate,
          non-infringing, secure, or fit for a particular purpose. You are responsible for deciding
          whether output is suitable for your use.
        </p>
      </LegalSection>

      <LegalSection number={5} title="Acceptable use" icon={ShieldCheck}>
        <p>
          You must follow our{" "}
          <Link href="/acceptable-use" className="text-primary hover:underline">
            Acceptable Use Policy
          </Link>
          . You may not use the Services for illegal, abusive, infringing, or harmful activity, or
          attempt to bypass security, billing, usage, or resource limits.
        </p>
      </LegalSection>

      <LegalSection number={6} title="Plans, charges, and refunds" icon={WalletCards}>
        <p>
          Paid features are billed according to the plan, usage, and pricing shown when you
          subscribe or make a change. The{" "}
          <Link href="/pricing" className="text-primary hover:underline">
            live pricing page
          </Link>{" "}
          is the source of current plan and usage rates.
        </p>
        <p>
          Our{" "}
          <Link href="/billing-refunds" className="text-primary hover:underline">
            Billing &amp; Refund Policy
          </Link>{" "}
          explains upgrades, downgrades, renewals, cancellation, rollover, overage, spending limits,
          and refund treatment. You authorize us and our payment processor to collect charges that
          you approve under those terms.
        </p>
      </LegalSection>

      <LegalSection number={7} title="Third-party services">
        <p>
          The Services may connect to third-party models, hosting, databases, domains, source-code
          hosts, payment services, or other integrations. Their services and terms are separate from
          ours. We are not responsible for third-party services, and you are responsible for the
          permissions, credentials, data, and costs associated with integrations you enable.
        </p>
      </LegalSection>

      <LegalSection number={8} title="Service changes, suspension, and termination">
        <p>
          We may change or discontinue features. We may restrict or suspend access when reasonably
          necessary to protect users, the Services, or third parties; respond to legal obligations;
          address nonpayment; or enforce these Terms and the Acceptable Use Policy.
        </p>
        <p>
          You may stop using the Services at any time. Ending an account does not erase payment
          obligations that arose before termination. Data export and deletion options are described
          in the Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection number={9} title="Disclaimers and limitation of liability" icon={AlertTriangle}>
        <p>
          To the fullest extent permitted by law, the Services are provided "as is" and "as
          available." We disclaim implied warranties, including merchantability, fitness for a
          particular purpose, and non-infringement. We do not promise uninterrupted service or that
          generated applications will be error-free, secure, or suitable for production.
        </p>
        <p>
          To the fullest extent permitted by law, MustaFlow AI Technology LLC will not be liable for
          indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost
          profits, data, goodwill, or business opportunities arising from the Services.
        </p>
      </LegalSection>

      <LegalSection number={10} title="Changes to these Terms">
        <p>
          We may update these Terms as the Services or legal requirements change. We will post the
          updated version and its effective date. When required, we will provide additional notice.
          Continued use after an update takes effect means you accept the revised Terms.
        </p>
      </LegalSection>

      <LegalSection number={11} title="Governing law and contact" icon={Scale}>
        <p>North Carolina law governs these Terms, without regard to conflict-of-law principles.</p>
        <p>
          Questions about these Terms may be sent to <LegalContact subject="Terms of Service" />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
