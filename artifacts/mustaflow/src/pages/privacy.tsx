import { Database, Eye, LockKeyhole, Shield } from "lucide-react";
import { LegalContact, LegalLayout, LegalSection } from "@/components/legal/legal-layout";

export default function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      description="How MustaFlow AI Technology LLC collects, uses, stores, and shares information."
      path="/privacy"
      icon={Shield}
      introduction={
        <p>
          This Privacy Policy explains how MustaFlow AI Technology LLC ("MustaFlow AI," "we," "us,"
          or "our") handles information when you use NabuFlow, Ora, Orax, and our related websites
          and services.
        </p>
      }
    >
      <LegalSection number={1} title="Information we collect" icon={Eye}>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Account information:</strong> identifiers and
            profile details supplied through Clerk, such as your name, email address, user ID, and
            organization membership.
          </li>
          <li>
            <strong className="text-foreground">Project and conversation content:</strong> prompts,
            messages, plans, generated code and files, uploads, images, page maps, project versions,
            checkpoints, deployment settings, and content you save in knowledge features.
          </li>
          <li>
            <strong className="text-foreground">Billing and usage information:</strong> plan and
            subscription identifiers, invoices, payment status, credit usage, build mode, token
            usage, and spending-limit settings. Payment card fields are collected directly by
            Stripe; MustaFlow AI does not receive the full card number or security code.
          </li>
          <li>
            <strong className="text-foreground">Technical and safety information:</strong> IP
            address, device and browser details, request and event logs, error reports, rate-limit
            identifiers, sandbox command results, security findings, and service-performance data.
          </li>
          <li>
            <strong className="text-foreground">Support and integration information:</strong>
            support requests and the connection details, permissions, and metadata needed for
            integrations or publishing features you choose to use.
          </li>
        </ul>
      </LegalSection>

      <LegalSection number={2} title="How we use information">
        <ul className="list-disc space-y-2 pl-5">
          <li>Authenticate accounts and provide the features you request.</li>
          <li>Generate, test, store, version, preview, and deploy your projects.</li>
          <li>Process subscriptions, usage, invoices, spending limits, and payment status.</li>
          <li>Maintain conversation context and user-selected knowledge or memory features.</li>
          <li>Secure the Services, prevent abuse, enforce limits, and investigate failures.</li>
          <li>Provide support, service notices, and operational communications.</li>
          <li>Measure reliability and improve product performance and build quality.</li>
          <li>Comply with law and enforce our agreements.</li>
        </ul>
      </LegalSection>

      <LegalSection number={3} title="Service providers and processing" icon={Database}>
        <p>Our code is configured to use the following providers for specific purposes:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong className="text-foreground">Clerk</strong> for authentication and account
            management.
          </li>
          <li>
            <strong className="text-foreground">Stripe</strong> for card collection, subscriptions,
            invoices, and payment events.
          </li>
          <li>
            <strong className="text-foreground">Neon PostgreSQL</strong> for platform data storage
            and, when enabled, databases provisioned for generated projects.
          </li>
          <li>
            <strong className="text-foreground">
              OpenAI, Anthropic, Google Gemini, and DeepSeek
            </strong>
            for AI processing. Depending on routing and feature availability, prompts, project
            context, files, and instructions may be sent to one or more of these providers to
            produce text, code, analysis, embeddings, speech, or images.
          </li>
          <li>
            <strong className="text-foreground">Upstash Redis</strong> for distributed rate limiting
            and abuse protection when configured.
          </li>
          <li>
            <strong className="text-foreground">Sentry</strong> for optional error and performance
            diagnostics when configured.
          </li>
          <li>
            <strong className="text-foreground">Resend</strong> for transactional and support email
            delivery when configured.
          </li>
          <li>
            <strong className="text-foreground">Replit, Fly.io, Cloudflare, and Namecheap</strong>
            for hosting, generated-project runtimes, publishing, certificates, and domain features,
            depending on the feature you use and the deployment configuration.
          </li>
        </ul>
        <p>
          We may also disclose information when you direct us to an integration, when required by
          law, to protect rights and safety, or as part of a business transaction subject to
          appropriate safeguards.
        </p>
      </LegalSection>

      <LegalSection number={4} title="Storage and security" icon={LockKeyhole}>
        <p>
          Platform records are stored in PostgreSQL. Project secrets saved through the secrets
          system are encrypted at rest with AES-256-GCM and returned to the interface only as masked
          previews. Authentication is handled by Clerk, so MustaFlow AI does not store your Clerk
          password.
        </p>
        <p>
          We use access controls, rate limits, audit records, and other safeguards designed to
          protect information. No system can guarantee absolute security, so you should use separate
          production credentials and rotate any secret you believe has been exposed.
        </p>
      </LegalSection>

      <LegalSection number={5} title="Retention and deletion">
        <p>
          We keep information while your account is active and as needed to provide the Services,
          maintain security and billing records, resolve disputes, and meet legal obligations.
          Retention varies by data type and purpose.
        </p>
        <p>
          The account-deletion flow removes sign-in credentials, soft-deletes covered project and
          workspace records, removes project chat messages, and schedules remaining covered account
          data for permanent erasure within 30 days. Some records may be retained when law, payment
          reconciliation, fraud prevention, or security obligations require it.
        </p>
      </LegalSection>

      <LegalSection number={6} title="Your choices and requests">
        <p>
          Settings include an account-data export and an account-deletion request. You can also
          delete projects, manage integrations, control optional memories and knowledge, and change
          billing settings through the available product controls.
        </p>
        <p>
          Depending on where you live, you may have rights to access, correct, delete, or receive a
          copy of personal information, or object to certain processing. We may need to verify your
          identity before completing a request.
        </p>
      </LegalSection>

      <LegalSection number={7} title="Policy changes and contact">
        <p>
          We may update this Policy as the Services, providers, or legal requirements change. We
          will post the revised version and effective date, and provide additional notice when
          required.
        </p>
        <p>
          Privacy questions and requests may be sent to <LegalContact subject="Privacy request" />.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
