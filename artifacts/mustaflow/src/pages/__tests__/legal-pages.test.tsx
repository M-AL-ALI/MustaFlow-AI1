import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { afterEach, describe, expect, it } from "vitest";
import AcceptableUsePage from "../acceptable-use";
import BillingRefundsPage from "../billing-refunds";
import PrivacyPage from "../privacy";
import TermsPage from "../terms";

const LEGAL_PAGES = [
  { name: "Terms of Service", component: TermsPage },
  { name: "Privacy Policy", component: PrivacyPage },
  { name: "Billing & Refund Policy", component: BillingRefundsPage },
  { name: "Acceptable Use Policy", component: AcceptableUsePage },
] as const;

const FOOTER_LINKS = [
  { name: "Terms", href: "/terms" },
  { name: "Privacy", href: "/privacy" },
  { name: "Billing & Refunds", href: "/billing-refunds" },
  { name: "Acceptable Use", href: "/acceptable-use" },
] as const;

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const FORBIDDEN_EMAIL_DOMAINS = ["@mustaflow.app", "@mustaflow.ai", "@mechconnect.net"];

function renderPage(Page: (typeof LEGAL_PAGES)[number]["component"]) {
  return render(
    <HelmetProvider>
      <Page />
    </HelmetProvider>,
  );
}

afterEach(() => cleanup());

describe("public legal pages", () => {
  for (const { name, component: Page } of LEGAL_PAGES) {
    it(`${name} uses the shared draft layout, approved contact, and complete footer`, () => {
      const { container } = renderPage(Page);

      expect(screen.getByRole("heading", { name, level: 1 })).toBeInTheDocument();
      expect(screen.getByTestId("legal-draft-notice")).toHaveTextContent(
        "Draft — effective date pending owner review.",
      );
      expect(screen.getByTestId("public-legal-footer")).toBeInTheDocument();

      for (const link of FOOTER_LINKS) {
        expect(screen.getByRole("link", { name: link.name })).toHaveAttribute("href", link.href);
      }
      expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute(
        "href",
        "mailto:support@mustaflow.com",
      );

      // The serialized markup keeps adjacent text nodes separated by tags, so
      // an address followed by the footer's company name cannot be parsed as
      // one artificial domain (as raw textContent would do).
      const searchable = container.innerHTML;
      const addresses = searchable.match(EMAIL_PATTERN) ?? [];

      expect(addresses.length).toBeGreaterThan(0);
      expect(new Set(addresses.map((address) => address.toLowerCase()))).toEqual(
        new Set(["support@mustaflow.com"]),
      );
      for (const domain of FORBIDDEN_EMAIL_DOMAINS) {
        expect(searchable.toLowerCase()).not.toContain(domain);
      }
    });
  }

  it("registers all four routes in both public route trees", () => {
    const srcRoot = join(__dirname, "..", "..");
    const appSource = readFileSync(join(srcRoot, "App.tsx"), "utf8");
    const publicAppSource = readFileSync(join(srcRoot, "PublicApp.tsx"), "utf8");

    for (const { href } of FOOTER_LINKS) {
      expect(appSource).toContain(`<Route path="${href}">`);
      expect(publicAppSource).toContain(`<Route path="${href}" component=`);
    }
  });
});
