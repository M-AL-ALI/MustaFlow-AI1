import { AlertTriangle, Ban, Gavel, ShieldCheck } from "lucide-react";
import { LegalContact, LegalLayout, LegalSection } from "@/components/legal/legal-layout";

export default function AcceptableUsePage() {
  return (
    <LegalLayout
      title="Acceptable Use Policy"
      description="Rules for safe and lawful use of MustaFlow AI, NabuFlow, Ora, and Orax."
      path="/acceptable-use"
      icon={ShieldCheck}
      introduction={
        <p>
          This Policy protects users, third parties, and the Services operated by MustaFlow AI
          Technology LLC. It applies to NabuFlow, Ora, Orax, generated projects, build sandboxes,
          deployments, and integrations.
        </p>
      }
    >
      <LegalSection number={1} title="Illegal or harmful activity" icon={Ban}>
        <p>You may not use the Services to create, facilitate, promote, or distribute:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>content or activity that violates applicable law or another person's rights;</li>
          <li>fraud, phishing, impersonation, deceptive schemes, or unauthorized surveillance;</li>
          <li>
            harassment, threats, exploitation, or content that creates a serious risk of harm; or
          </li>
          <li>instructions or systems intended to enable illegal access or wrongdoing.</li>
        </ul>
      </LegalSection>

      <LegalSection number={2} title="Malware, sandbox abuse, and security" icon={AlertTriangle}>
        <p>You may not:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            create or distribute malware, ransomware, credential theft, destructive code, or
            denial-of-service tooling;
          </li>
          <li>
            use the build sandbox for unauthorized access, scanning, cryptomining, spam,
            persistence, or workloads unrelated to building and testing your project;
          </li>
          <li>
            probe, bypass, disable, or interfere with platform security, isolation, monitoring, or
            rate limits; or
          </li>
          <li>access another user's account, project, data, or systems without authorization.</li>
        </ul>
        <p>
          Good-faith security research must stay within an expressly authorized scope and must not
          access other users' data or disrupt the Services.
        </p>
      </LegalSection>

      <LegalSection number={3} title="Intellectual property and privacy">
        <p>
          You may not submit, generate, publish, or deploy content that infringes intellectual
          property, privacy, publicity, confidentiality, or other rights. Do not upload personal,
          confidential, or regulated information unless you are authorized to process it and have
          assessed whether the Services are appropriate for that information.
        </p>
      </LegalSection>

      <LegalSection number={4} title="Billing and limit integrity" icon={ShieldCheck}>
        <p>
          You may not evade charges, abuse promotions, create accounts to bypass restrictions,
          conceal usage, tamper with metering, or attempt to circumvent plan, credit, spending,
          concurrency, queue, provider, or resource limits.
        </p>
      </LegalSection>

      <LegalSection number={5} title="Automated and excessive use">
        <p>
          Automated use must follow documented interfaces and remain within applicable limits. You
          may not place disproportionate load on the Services, flood public endpoints, monopolize
          shared resources, or use generated deployments to distribute abusive traffic.
        </p>
      </LegalSection>

      <LegalSection number={6} title="Reporting abuse">
        <p>
          Report suspected abuse, infringement, or security concerns to{" "}
          <LegalContact subject="Abuse report" />. Include enough detail for us to identify the
          project or activity, but do not send secrets or full payment-card details.
        </p>
      </LegalSection>

      <LegalSection number={7} title="Enforcement" icon={Gavel}>
        <p>
          We may investigate suspected violations and remove content, restrict features, suspend
          access, or terminate accounts or projects. We may preserve relevant evidence and report
          conduct to authorities when required or permitted by law. Where practical and safe, we may
          provide notice and an opportunity to correct a violation.
        </p>
        <p>
          Questions about this Policy may be sent to{" "}
          <LegalContact subject="Acceptable Use Policy" />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
