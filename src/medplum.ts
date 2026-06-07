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

/** Best-available clinical date on a resource (for date-descending sort). */
function resourceDate(resource: unknown): string {
  const r = (resource ?? {}) as Record<string, unknown> & {
    period?: { start?: string };
    billablePeriod?: { start?: string };
    meta?: { lastUpdated?: string };
  };
  return (
    (r.effectiveDateTime as string) ??
    r.period?.start ??
    r.billablePeriod?.start ??
    (r.created as string) ??
    (r.onsetDateTime as string) ??
    (r.occurrenceDateTime as string) ??
    (r.authoredOn as string) ??
    (r.performedDateTime as string) ??
    (r.recordedDate as string) ??
    (r.issued as string) ??
    r.meta?.lastUpdated ??
    ""
  );
}

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

  /** GET a FHIR URL — either a relative path or an absolute next-link — with the bearer. */
  private async fetchFhir(urlOrPath: string): Promise<Bundle> {
    const token = await this.accessToken();
    const url = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${this.settings.baseUrl}/fhir/R4/${urlOrPath}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" },
    });
    if (!res.ok) {
      throw new Error(`FHIR GET ${urlOrPath} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as Bundle;
  }

  /**
   * The COMPLETE chart: Patient/$everything followed across ALL pages, PLUS Coverage
   * merged in explicitly.
   *
   * $everything returns the whole patient compartment but paginates at _count=1000
   * (via Bundle.link[next]); we follow every page and dedupe by resourceType/id
   * (referenced resources like Organizations recur across pages). Medplum caps
   * _offset at 10000, so for very large charts we stop gracefully at the ceiling.
   * Coverage can sit past that ceiling (or be sorted out of reach), so we fetch it
   * directly and merge — guaranteeing insurance is always present. Finally we sort
   * everything by date, most-recent first.
   */
  async getChartBundle(patientId: string): Promise<Bundle> {
    const seen = new Set<string>();
    const entry: NonNullable<Bundle["entry"]> = [];
    const add = (b: Bundle): void => {
      for (const e of b.entry ?? []) {
        const r = e.resource;
        if (!r) continue;
        const key = `${r.resourceType}/${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entry.push(e);
      }
    };

    // 1) Walk every page of $everything.
    let url: string | undefined = `Patient/${patientId}/$everything?_count=1000`;
    let pages = 0;
    while (url && pages < 100) {
      let page: Bundle;
      try {
        page = await this.fetchFhir(url);
      } catch (err) {
        if (err instanceof Error && err.message.includes("offset exceeds maximum")) break;
        throw err;
      }
      add(page);
      url = page.link?.find((l) => l.relation === "next")?.url;
      pages += 1;
    }

    // 2) Guarantee the Patient (demographics + assigned PCP) and Coverage — both can
    //    be absent from $everything or sit past the _offset ceiling.
    add(await this.fetchFhir(`Patient?_id=${patientId}`));
    add(await this.fetchFhir(`Coverage?beneficiary=Patient/${patientId}&_count=50`));

    // 3) Sort for the best index: group by resource type, most-recent first within each.
    entry.sort((a, b) => {
      const ta = a.resource?.resourceType ?? "";
      const tb = b.resource?.resourceType ?? "";
      if (ta !== tb) return ta.localeCompare(tb);
      return resourceDate(b.resource).localeCompare(resourceDate(a.resource));
    });

    return { resourceType: "Bundle", type: "collection", entry } as Bundle;
  }

  /**
   * The method the agent calls once Watchman has resolved a patient id: fetch the
   * complete chart and shape it into Moss documents destined for chart-{patientId}.
   */
  async getChartForMoss(patientId: string): Promise<ChartIndex> {
    const bundle = await this.getChartBundle(patientId);
    return {
      indexName: `chart-${patientId}`,
      docs: chartToMossDocs(patientId, bundle),
    };
  }

  /** All Patient ids in the project — for offline chart seeding. */
  async listPatientIds(): Promise<string[]> {
    const bundle = await this.fetchFhir(`Patient?_count=200&_elements=id`);
    return (bundle.entry ?? [])
      .map((e) => e.resource?.id)
      .filter((id): id is string => Boolean(id));
  }
}
