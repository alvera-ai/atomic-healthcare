/**
 * watchman.ts — thin wrapper over Watchman, repurposed as a patient EMPI.
 *
 * Watchman does the fuzzy "which person is this" match the agent needs (a plain
 * FHIR name+birthdate search can return several people). The RECORD_ID it returns
 * IS the Medplum Patient id (set at seed time), so a match bridges straight to the
 * chart. `type=person` is required, or Watchman rejects the demographic params.
 */

export interface WatchmanSettings {
  baseUrl: string;
}

export function watchmanSettingsFromEnv(): WatchmanSettings {
  return { baseUrl: (process.env.WATCHMAN_URL ?? "http://localhost:8084").replace(/\/$/, "") };
}

export interface PatientMatch {
  /** RECORD_ID = Medplum Patient id. */
  patientId: string;
  name: string;
  /** Match confidence, 0–1. */
  confidence: number;
}

export interface ResolveQuery {
  name: string;
  birthDate?: string;
  phone?: string;
  address?: string;
}

export class WatchmanClient {
  constructor(private readonly settings: WatchmanSettings) {}

  /** Fuzzy-resolve a caller to candidate patients, best match first. */
  async resolvePatient(q: ResolveQuery): Promise<PatientMatch[]> {
    const params = new URLSearchParams({ type: "person", name: q.name });
    if (q.birthDate) params.set("birthDate", q.birthDate);
    if (q.phone) params.set("phone", q.phone);
    if (q.address) params.set("address", q.address);

    const res = await fetch(`${this.settings.baseUrl}/v2/search?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Watchman search failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      entities?: Array<{ name: string; match: number; sourceID: string }>;
    };
    return (body.entities ?? []).map((e) => ({
      patientId: e.sourceID,
      name: e.name,
      confidence: e.match,
    }));
  }
}
