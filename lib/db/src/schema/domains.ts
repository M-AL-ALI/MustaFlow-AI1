import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const DOMAIN_RECORD_TYPES = ["a", "cname"] as const;
export type DomainRecordType = (typeof DOMAIN_RECORD_TYPES)[number];

export const DOMAIN_VERIFICATION_STATUSES = ["pending", "verified", "failed"] as const;
export type DomainVerificationStatus = (typeof DOMAIN_VERIFICATION_STATUSES)[number];

export const projectDomainsTable = pgTable(
  "project_domains",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    // recordType: 'a' for apex domains (root domain, no subdomain prefix),
    // 'cname' for subdomains. Determines which DNS record type is shown in instructions.
    recordType: text("record_type").notNull().default("cname"),
    verificationToken: text("verification_token").notNull(),
    // verificationStatus: pending | verified | failed
    verificationStatus: text("verification_status").notNull().default("pending"),
    // sslStatus: pending | provisioning | active | expiring_soon | expired | failed
    sslStatus: text("ssl_status").notNull().default("pending"),
    // environment: which deployment slot this custom domain is attached to.
    // "production" (default) | "staging"
    environment: text("environment").notNull().default("production"),
    // Cloudflare for SaaS custom hostname integration (Task #553).
    // cfHostnameId: Cloudflare custom hostname UUID stored after createCustomHostname succeeds.
    //   Null means CF has not been provisioned for this domain yet.
    // sslLastCheckedAt: when we last polled Cloudflare for this cert's status.
    // sslExpiresAt: cert expiry date returned by Cloudflare (populated once cert is active).
    cfHostnameId: text("cf_hostname_id"),
    sslLastCheckedAt: timestamp("ssl_last_checked_at", { withTimezone: true }),
    sslExpiresAt: timestamp("ssl_expires_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // BYO cert fields (Task #554).
    // sslSource: 'cloudflare' (default, Cloudflare-issued DV cert) | 'byo' (user-uploaded cert).
    // byoCertExpiresAt: parsed expiry from the uploaded cert.
    // byoCertSubject: CN / SAN from the uploaded cert for display.
    sslSource: text("ssl_source").notNull().default("cloudflare"),
    byoCertExpiresAt: timestamp("byo_cert_expires_at", { withTimezone: true }),
    byoCertSubject: text("byo_cert_subject"),
    // Security config: per-domain WAF, rate limits, geo-blocking, IP allow/deny, mTLS — Task #560.
    // Shape: { rateLimitRps?: number, geoBlock?: string[], ipAllow?: string[], ipDeny?: string[], mtlsEnabled?: boolean, mtlsCaCert?: string, wafEnabled?: boolean, botManagement?: boolean }
    securityConfig: jsonb("security_config").$type<DomainSecurityConfig>(),
    // Suspension: null = active. When set, hostname middleware returns 451.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspensionReason: text("suspension_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_domains_hostname_unique").on(t.hostname)],
);

export interface DomainSecurityConfig {
  rateLimitRps?: number;
  geoBlock?: string[];
  ipAllow?: string[];
  ipDeny?: string[];
  mtlsEnabled?: boolean;
  mtlsCaCert?: string;
  wafEnabled?: boolean;
  botManagement?: boolean;
}

export type ProjectDomain = typeof projectDomainsTable.$inferSelect;
export type InsertProjectDomain = typeof projectDomainsTable.$inferInsert;
