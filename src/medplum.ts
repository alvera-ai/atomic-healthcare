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

import type { Appointment, Bundle, Communication, Coverage, Patient, Slot } from "@medplum/fhirtypes";
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

export interface SlotInfo {
  id: string;
  start: string;
  end: string;
  practitionerId?: string;
}

export interface CoverageInfo {
  plan: string; // e.g. "Managed Care (HMO)" or "Fee-for-Service"
  payer: string;
  managedCare: boolean;
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

  /** Authenticated FHIR create (POST). */
  private async fhirCreate<T>(resource: T): Promise<T> {
    const token = await this.accessToken();
    const type = (resource as { resourceType?: string }).resourceType;
    const res = await fetch(`${this.settings.baseUrl}/fhir/R4/${type}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/fhir+json",
        Accept: "application/fhir+json",
      },
      body: JSON.stringify(resource),
    });
    if (!res.ok) throw new Error(`FHIR create ${type} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Mark a Slot busy (JSON Patch) once it's booked. */
  private async markSlotBusy(slotId: string): Promise<void> {
    const token = await this.accessToken();
    await fetch(`${this.settings.baseUrl}/fhir/R4/Slot/${slotId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json-patch+json" },
      body: JSON.stringify([{ op: "replace", path: "/status", value: "busy" }]),
    });
  }

  private async firstResource<T>(path: string): Promise<T | undefined> {
    const b = await this.fetchFhir(path);
    return b.entry?.[0]?.resource as T | undefined;
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

  /** Register a brand-new patient (used when Watchman finds no match). Returns the id. */
  async createPatient(input: {
    given: string;
    family: string;
    birthDate?: string;
    gender?: Patient["gender"];
    phone?: string;
  }): Promise<string> {
    const token = await this.accessToken();
    const patient: Patient = {
      resourceType: "Patient",
      name: [{ given: [input.given], family: input.family }],
      ...(input.birthDate ? { birthDate: input.birthDate } : {}),
      ...(input.gender ? { gender: input.gender } : {}),
      ...(input.phone ? { telecom: [{ system: "phone", value: input.phone }] } : {}),
    };
    const res = await fetch(`${this.settings.baseUrl}/fhir/R4/Patient`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/fhir+json",
        Accept: "application/fhir+json",
      },
      body: JSON.stringify(patient),
    });
    if (!res.ok) {
      throw new Error(`create Patient failed: ${res.status} ${await res.text()}`);
    }
    const created = (await res.json()) as Patient;
    if (!created.id) throw new Error("create Patient returned no id");
    return created.id;
  }

  /** All Patient ids in the project — for offline chart seeding. */
  async listPatientIds(): Promise<string[]> {
    const bundle = await this.fetchFhir(`Patient?_count=200&_elements=id`);
    return (bundle.entry ?? [])
      .map((e) => e.resource?.id)
      .filter((id): id is string => Boolean(id));
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  /** The patient's active coverage (plan type + payer, and whether it's managed care). */
  async getCoverage(patientId: string): Promise<CoverageInfo | null> {
    const c = await this.firstResource<Coverage>(`Coverage?beneficiary=Patient/${patientId}&_count=5`);
    if (!c) return null;
    const plan = c.type?.text ?? "Coverage";
    return {
      plan,
      payer: c.payor?.[0]?.display ?? "",
      managedCare: /managed|hmo/i.test(plan),
    };
  }

  /** The patient's assigned PCP id, if any (Patient.generalPractitioner). */
  async getPrimaryPractitionerId(patientId: string): Promise<string | undefined> {
    const p = await this.firstResource<Patient>(`Patient?_id=${patientId}`);
    return p?.generalPractitioner?.[0]?.reference?.split("/")[1];
  }

  /** Schedule ids for a practitioner. */
  private async scheduleIdsFor(practitionerId: string): Promise<string[]> {
    const b = await this.fetchFhir(`Schedule?actor=Practitioner/${practitionerId}&_count=10`);
    return (b.entry ?? []).map((e) => e.resource?.id).filter((id): id is string => Boolean(id));
  }

  /** The practitioner behind a Schedule. */
  private async practitionerForSchedule(scheduleId: string): Promise<string | undefined> {
    const s = await this.firstResource<{ actor?: Array<{ reference?: string }> }>(`Schedule?_id=${scheduleId}`);
    return s?.actor?.find((a) => a.reference?.startsWith("Practitioner/"))?.reference?.split("/")[1];
  }

  /**
   * Earliest free slot starting on/after `afterISO` (default now). If `practitionerId`
   * is given, restrict to that PCP's schedules; otherwise any practitioner.
   */
  async findEarliestSlot(opts: { afterISO?: string; practitionerId?: string } = {}): Promise<SlotInfo | null> {
    const after = opts.afterISO ?? new Date().toISOString();
    const scheduleIds = opts.practitionerId ? await this.scheduleIdsFor(opts.practitionerId) : undefined;

    const b = await this.fetchFhir(`Slot?status=free&start=ge${after}&_sort=start&_count=100`);
    for (const e of b.entry ?? []) {
      const s = e.resource as Slot | undefined;
      const schedId = s?.schedule?.reference?.split("/")[1];
      if (!s?.id || !s.start || !s.end || !schedId) continue;
      if (scheduleIds && scheduleIds.length > 0 && !scheduleIds.includes(schedId)) continue;
      const practitionerId = opts.practitionerId ?? (await this.practitionerForSchedule(schedId));
      return { id: s.id, start: s.start, end: s.end, practitionerId };
    }
    return null;
  }

  /** Book a free Slot: create the Appointment and mark the slot busy. */
  async bookAppointment(patientId: string, slotId: string): Promise<{ appointmentId: string; start: string }> {
    const slot = await this.firstResource<Slot>(`Slot?_id=${slotId}`);
    if (!slot?.start || !slot.end) throw new Error(`slot ${slotId} not found or has no time`);
    const schedId = slot.schedule?.reference?.split("/")[1];
    const practitionerId = schedId ? await this.practitionerForSchedule(schedId) : undefined;

    const appt = await this.fhirCreate<Appointment>({
      resourceType: "Appointment",
      status: "booked",
      start: slot.start,
      end: slot.end,
      slot: [{ reference: `Slot/${slotId}` }],
      participant: [
        { actor: { reference: `Patient/${patientId}` }, status: "accepted" },
        ...(practitionerId
          ? [{ actor: { reference: `Practitioner/${practitionerId}` }, status: "accepted" as const }]
          : []),
      ],
    });
    await this.markSlotBusy(slotId);
    return { appointmentId: appt.id ?? "", start: slot.start };
  }

  /**
   * Managed-care guarantee: when no free slot is available, create an extra slot
   * after 5 PM on the patient's PCP schedule (next weekday) and book it.
   */
  async createPrioritySlotAndBook(patientId: string): Promise<{ appointmentId: string; start: string } | null> {
    const practitionerId = await this.getPrimaryPractitionerId(patientId);
    if (!practitionerId) return null;
    const scheduleId = (await this.scheduleIdsFor(practitionerId))[0];
    if (!scheduleId) return null;

    const start = new Date();
    start.setDate(start.getDate() + 1);
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
    start.setHours(17, 0, 0, 0); // 5:00 PM overflow
    const end = new Date(start.getTime() + 30 * 60_000);

    const slot = await this.fhirCreate<Slot>({
      resourceType: "Slot",
      schedule: { reference: `Schedule/${scheduleId}` },
      status: "free",
      start: start.toISOString(),
      end: end.toISOString(),
      comment: "After-hours overflow (managed-care priority)",
    });
    return this.bookAppointment(patientId, slot.id ?? "");
  }

  /** Write the call transcript to the patient's chart as a FHIR Communication. */
  async logCallSummary(patientId: string, transcript: string): Promise<string> {
    const c = await this.fhirCreate<Communication>({
      resourceType: "Communication",
      status: "completed",
      subject: { reference: `Patient/${patientId}` },
      sent: new Date().toISOString(),
      category: [
        {
          text: "CareOps Voice call",
          coding: [{ system: "http://terminology.hl7.org/CodeSystem/communication-category", code: "notification" }],
        },
      ],
      medium: [
        {
          coding: [
            { system: "http://terminology.hl7.org/CodeSystem/v3-ParticipationMode", code: "PHONE", display: "telephone" },
          ],
        },
      ],
      topic: { text: "After-hours CareOps Voice call transcript" },
      payload: [{ contentString: transcript }],
    });
    return c.id ?? "";
  }
}
