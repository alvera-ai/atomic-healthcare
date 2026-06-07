/**
 * medplum.ts — the thin in-process Medplum wrapper the LiveKit agent calls.
 *
 * This is the ONLY place that talks to Medplum over HTTP. It exposes a small,
 * deliberate API (the safety boundary): resolve a chart, turn it into Moss docs,
 * and (later) read coverage / book appointments. The agent's llm.tool()s call
 * these methods — they never touch raw FHIR.
 *
 * Auth: OAuth2 client-credentials (machine identity). The bearer token is cached
 * in-process and refreshed ~1 min before it expires, so a long call makes the
 * token exchange at most once.
 */

import type { Bundle } from "@medplum/fhirtypes";
import { chartToMossDocs } from "./chart-to-moss.ts";
import type { MossDoc } from "./moss-doc.ts";

export interface MedplumSettings {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

/** Read settings from the environment (Bun auto-loads .env). */
export function settingsFromEnv(): MedplumSettings {
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Set MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET in .env");
  }
  return {
    baseUrl: (process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103/").replace(/\/$/, ""),
    clientId,
    clientSecret,
  };
}

/** What a Moss chart load returns: the index name + the docs to put in it. */
export interface ChartIndex {
  indexName: string; // chart-{patientId} — 1 patient = 1 index
  docs: MossDoc[];
}

export class MedplumClient {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly settings: MedplumSettings) {}

  /** OAuth2 client-credentials grant, cached until ~1 min before expiry. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now) {
      return this.token.value;
    }

    const res = await fetch(`${this.settings.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: now + (body.expires_in - 60) * 1000, // refresh 60s early
    };
    return this.token.value;
  }

  /** Authenticated FHIR GET. */
  private async fhirGet<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${this.settings.baseUrl}/fhir/R4/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" },
    });
    if (!res.ok) {
      throw new Error(`FHIR GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** The whole chart as a FHIR Bundle (Patient + everything in their compartment). */
  async getChartBundle(patientId: string): Promise<Bundle> {
    return this.fhirGet<Bundle>(`Patient/${patientId}/$everything?_count=1000`);
  }

  /**
   * The method the agent calls once Watchman has resolved a patient id: fetch the
   * chart and shape it into Moss documents destined for the index chart-{patientId}.
   */
  async getChartForMoss(patientId: string): Promise<ChartIndex> {
    const bundle = await this.getChartBundle(patientId);
    return {
      indexName: `chart-${patientId}`,
      docs: chartToMossDocs(patientId, bundle),
    };
  }
}
