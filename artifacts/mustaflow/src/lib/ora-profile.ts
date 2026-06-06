import { authFetch } from "@/lib/api-fetch";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export interface OraProfile {
  id: number;
  userId: string;
  preferredName: string | null;
  occupation: string | null;
  industry: string | null;
  goals: string | null;
  skillLevel: string | null;
  preferredLanguage: string | null;
  responseStyle: string | null;
  avoid: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OraProfileInput = Pick<
  OraProfile,
  | "preferredName"
  | "occupation"
  | "industry"
  | "goals"
  | "skillLevel"
  | "preferredLanguage"
  | "responseStyle"
  | "avoid"
>;

export async function fetchOraProfile(): Promise<OraProfile | null> {
  const res = await authFetch(`${BASE}/api/ora/profile`);
  if (!res.ok) throw new Error(`Failed to load profile (${res.status})`);
  const data = (await res.json()) as { profile: OraProfile | null };
  return data.profile;
}

export async function saveOraProfile(input: OraProfileInput): Promise<OraProfile> {
  const res = await authFetch(`${BASE}/api/ora/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to save profile (${res.status})`);
  const data = (await res.json()) as { profile: OraProfile };
  return data.profile;
}
