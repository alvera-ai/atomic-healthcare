/**
 * seed.ts — import the Synthea cohort into Medplum, enable scheduling, and emit
 * the Watchman identity file.
 *
 * Native import: Synthea emits FHIR *transaction* bundles; we POST each via
 * MedplumClient.executeBatch (Medplum resolves the internal references). Order
 * matters — hospitalInformation + practitionerInformation first (they create the
 * Organizations/Practitioners that patient bundles reference by conditional
 * reference), then the patient bundles.
 *
 * Then, for each imported Practitioner, we create a Schedule + free Slots so the
 * provider app calendar shows bookable availability.
 *
 * Auth: idiomatic OAuth via @medplum/core. Defaults to the local admin
 * (password grant); set MEDPLUM_CLIENT_ID / MEDPLUM_CLIENT_SECRET for
 * client-credentials instead.
 */

import { MedplumClient } from "@medplum/core";
import type {
  Bundle,
  Coverage,
  Organization,
  Patient,
  PlanDefinition,
  Practitioner,
  Schedule,
  Slot,
} from "@medplum/fhirtypes";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103/";
const FHIR_DIR = process.env.SYNTHEA_DIR ?? "seed-output/synthea/fhir";
const OUT_JSONL = process.env.WATCHMAN_JSONL ?? "seed-output/patients.jsonl";
const WATCHMAN_SOURCE = "ATOMIC_PATIENTS";

async function authenticate(medplum: MedplumClient): Promise<void> {
  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (clientId && clientSecret) {
    await medplum.startClientLogin(clientId, clientSecret);
    return;
  }
  const login = await medplum.startLogin({
    email: process.env.MEDPLUM_EMAIL ?? "admin@example.com",
    password: process.env.MEDPLUM_PASSWORD ?? "medplum_admin",
  });
  if (!login.code) throw new Error("Medplum login did not return a code.");
  await medplum.processCode(login.code);
}

function readBundle(file: string): Bundle {
  return JSON.parse(readFileSync(join(FHIR_DIR, file), "utf8")) as Bundle;
}

/** POST a transaction bundle; throw if any entry failed. */
async function importBundle(
  medplum: MedplumClient,
  bundle: Bundle,
  label: string,
): Promise<Bundle> {
  const result = await medplum.executeBatch(bundle);
  const bad = (result.entry ?? []).find((e) => {
    const status = e.response?.status ?? "";
    return !status.startsWith("20");
  });
  if (bad) {
    throw new Error(
      `${label}: an entry failed — ${bad.response?.status} ${JSON.stringify(bad.response?.outcome ?? {}).slice(0, 300)}`,
    );
  }
  return result;
}

type SeededPatient = {
  id: string;
  first: string;
  last: string;
  birthDate?: string;
  gender?: string;
  line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  deceased: boolean;
};

/** Pull the created Patient id (from the response) + demographics (from the request). */
function extractPatient(reqBundle: Bundle, resBundle: Bundle): SeededPatient | null {
  const entries = reqBundle.entry ?? [];
  const idx = entries.findIndex((e) => e.resource?.resourceType === "Patient");
  if (idx < 0) return null;
  const p = entries[idx]?.resource as Patient | undefined;
  if (!p) return null;
  const location = resBundle.entry?.[idx]?.response?.location ?? "";
  const id = location.split("/")[1];
  if (!id) return null;
  const name = p.name?.[0];
  const addr = p.address?.[0];
  return {
    id,
    first: name?.given?.[0] ?? "",
    last: name?.family ?? "",
    birthDate: p.birthDate,
    gender: p.gender,
    line1: addr?.line?.[0],
    city: addr?.city,
    state: addr?.state,
    zip: addr?.postalCode,
    phone: p.telecom?.find((t) => t.system === "phone")?.value,
    deceased: Boolean(p.deceasedDateTime || p.deceasedBoolean),
  };
}

function senzingLine(p: SeededPatient): string {
  const gender = p.gender === "male" ? "M" : p.gender === "female" ? "F" : "";
  const record: Record<string, string> = {
    DATA_SOURCE: WATCHMAN_SOURCE,
    RECORD_ID: p.id,
    RECORD_TYPE: "PERSON",
    NAME_FIRST: p.first,
    NAME_LAST: p.last,
  };
  if (p.birthDate) record.DATE_OF_BIRTH = p.birthDate;
  if (gender) record.GENDER = gender;
  if (p.line1) record.ADDR_LINE1 = p.line1;
  if (p.city) record.ADDR_CITY = p.city;
  if (p.state) record.ADDR_STATE = p.state;
  if (p.zip) record.ADDR_POSTAL_CODE = p.zip;
  record.ADDR_COUNTRY = "US";
  if (p.phone) record.PHONE_NUMBER = p.phone;
  return JSON.stringify(record);
}

/** Next `days` weekdays starting tomorrow. */
function upcomingWeekdays(days: number): Date[] {
  const out: Date[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (out.length < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(d));
  }
  return out;
}

/** Clinic hours: morning 9:00–12:00 and afternoon 14:00–17:00 (30-min slots). */
const CLINIC_HOURS: readonly number[] = [9, 10, 11, 14, 15, 16];

/** Create a Schedule for a practitioner and free 30-min slots across clinic hours, next 10 weekdays. */
export async function enableScheduling(
  medplum: MedplumClient,
  practitioner: Practitioner,
): Promise<number> {
  const schedule = await medplum.createResource<Schedule>({
    resourceType: "Schedule",
    active: true,
    actor: [{ reference: `Practitioner/${practitioner.id}` }],
    comment: "Atomic Healthcare demo availability",
  });
  let slots = 0;
  for (const day of upcomingWeekdays(10)) {
    for (const hour of CLINIC_HOURS) {
      for (const minute of [0, 30]) {
        const start = new Date(day);
        start.setHours(hour, minute, 0, 0);
        const end = new Date(start.getTime() + 30 * 60_000);
        await medplum.createResource<Slot>({
          resourceType: "Slot",
          schedule: { reference: `Schedule/${schedule.id}` },
          status: "free",
          start: start.toISOString(),
          end: end.toISOString(),
        });
        slots++;
      }
    }
  }
  return slots;
}

/**
 * Care templates — the provider app's "Create Visit" form REQUIRES a PlanDefinition
 * ("Care template") to book. A minimal active PlanDefinition is enough: booking runs
 * PlanDefinition/$apply (fine with no actions) and the charge-item step skips cleanly
 * when billing extensions are absent. Idempotent (skips templates already present).
 */
const CARE_TEMPLATES: ReadonlyArray<readonly [name: string, title: string]> = [
  ["new-patient-visit", "New Patient Visit"],
  ["annual-wellness-visit", "Annual Wellness Visit"],
  ["diabetes-followup", "Diabetes Management Follow-up"],
  ["hypertension-followup", "Hypertension Follow-up"],
  ["telehealth-checkin", "Telehealth Check-in"],
];

export async function seedCareTemplates(medplum: MedplumClient): Promise<number> {
  let created = 0;
  for (const [name, title] of CARE_TEMPLATES) {
    const existing = await medplum.searchResources("PlanDefinition", { name });
    if (existing.length > 0) continue;
    await medplum.createResource<PlanDefinition>({
      resourceType: "PlanDefinition",
      status: "active",
      name,
      title,
      type: { text: "Clinical Protocol" },
      description: `${title} — care template for booking a visit.`,
    });
    created += 1;
  }
  return created;
}

/**
 * Insurance — give every patient a Coverage. Deterministic split: the first
 * `managedCareCount` LIVING patients get managed care (HMO) with an assigned primary
 * care physician (Patient.generalPractitioner, round-robin across practitioners); the
 * rest get fee-for-service (Medicare). Wipes existing Coverage first so re-running is
 * idempotent and the 4/20 split is exact.
 */
const PAYERS = {
  managed: { ref: "sunshine-health", name: "Sunshine Health Plan", code: "HMO", typeText: "Managed Care (HMO)" },
  ffs: { ref: "medicare-ffs", name: "Medicare", code: "FFS", typeText: "Fee-for-Service" },
} as const;

async function findOrCreatePayer(
  medplum: MedplumClient,
  payer: { ref: string; name: string },
): Promise<Organization> {
  const found = await medplum.searchResources("Organization", {
    identifier: `http://atomic.health/payer|${payer.ref}`,
  });
  if (found[0]) return found[0];
  return medplum.createResource<Organization>({
    resourceType: "Organization",
    active: true,
    name: payer.name,
    identifier: [{ system: "http://atomic.health/payer", value: payer.ref }],
    type: [
      {
        coding: [
          { system: "http://terminology.hl7.org/CodeSystem/organization-type", code: "pay", display: "Payer" },
        ],
      },
    ],
  });
}

export async function seedCoverage(
  medplum: MedplumClient,
  managedCareCount = 4,
): Promise<{ managed: number; ffs: number; withPcp: number }> {
  // Clean slate so the split is exact and re-runs are idempotent.
  for (const c of await medplum.searchResources("Coverage", { _count: "200" })) {
    if (c.id) await medplum.deleteResource("Coverage", c.id);
  }

  const managedPayer = await findOrCreatePayer(medplum, PAYERS.managed);
  const ffsPayer = await findOrCreatePayer(medplum, PAYERS.ffs);

  const patients = (await medplum.searchResources("Patient", { _count: "200" })).sort((a, b) =>
    (a.id ?? "").localeCompare(b.id ?? ""),
  );
  // Only real clinicians can be a PCP — Synthea practitioners carry a us-npi
  // identifier; the bootstrap "Medplum Admin" Practitioner has none, so it's excluded.
  const practitioners = (await medplum.searchResources("Practitioner", { _count: "100" })).filter((p) =>
    p.identifier?.some((i) => i.system === "http://hl7.org/fhir/sid/us-npi"),
  );

  const living = patients.filter((p) => !(p.deceasedDateTime || p.deceasedBoolean));
  const managedIds = new Set(living.slice(0, managedCareCount).map((p) => p.id));

  // PCP on record: every managed-care patient + half of the fee-for-service patients
  // (so some FFS patients have an assigned doctor and some don't — realistic variety).
  const ffsPatients = patients.filter((p) => !managedIds.has(p.id));
  const pcpIds = new Set<string | undefined>([
    ...managedIds,
    ...ffsPatients.slice(0, Math.floor(ffsPatients.length / 2)).map((p) => p.id),
  ]);

  let managed = 0;
  let ffs = 0;
  let withPcp = 0;
  let pcpIdx = 0;
  for (const p of patients) {
    const isManaged = managedIds.has(p.id);
    const payer = isManaged ? PAYERS.managed : PAYERS.ffs;
    const payerOrg = isManaged ? managedPayer : ffsPayer;

    if (pcpIds.has(p.id) && practitioners.length > 0) {
      const pcp = practitioners[pcpIdx % practitioners.length];
      pcpIdx += 1;
      const nm = pcp?.name?.[0];
      const display = `${nm?.given?.join(" ") ?? ""} ${nm?.family ?? ""}`.trim();
      await medplum.updateResource<Patient>({
        ...p,
        generalPractitioner: [{ reference: `Practitioner/${pcp?.id}`, display }],
      });
      withPcp += 1;
    }

    await medplum.createResource<Coverage>({
      resourceType: "Coverage",
      status: "active",
      type: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: payer.code, display: payer.typeText }],
        text: payer.typeText,
      },
      beneficiary: { reference: `Patient/${p.id}` },
      subscriber: { reference: `Patient/${p.id}` },
      subscriberId: `${payer.ref}-${(p.id ?? "").slice(0, 8)}`,
      relationship: {
        coding: [{ system: "http://terminology.hl7.org/CodeSystem/subscriber-relationship", code: "self" }],
      },
      payor: [{ reference: `Organization/${payerOrg.id}`, display: payerOrg.name }],
      period: { start: "2026-01-01" },
      class: [
        {
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "plan" }] },
          value: payer.ref,
          name: payer.name,
        },
      ],
    });
    if (isManaged) managed += 1;
    else ffs += 1;
  }
  return { managed, ffs, withPcp };
}

async function main(): Promise<void> {
  const medplum = new MedplumClient({ baseUrl: BASE_URL, fetch });
  await authenticate(medplum);
  console.log(`✓ authenticated to ${BASE_URL}`);

  const files = readdirSync(FHIR_DIR).filter((f) => f.endsWith(".json"));
  const infra = files.filter((f) => f.startsWith("hospitalInformation") || f.startsWith("practitionerInformation"));
  const patients = files.filter((f) => !f.startsWith("hospitalInformation") && !f.startsWith("practitionerInformation")).sort();

  // 1) Orgs + practitioners first so patient conditional references resolve.
  for (const f of infra) {
    await importBundle(medplum, readBundle(f), f);
    console.log(`  imported ${f}`);
  }

  // 2) Patient bundles (full charts).
  const seeded: SeededPatient[] = [];
  for (const f of patients) {
    const req = readBundle(f);
    const res = await importBundle(medplum, req, f);
    const p = extractPatient(req, res);
    if (p) seeded.push(p);
    console.log(`  imported ${f}${p ? ` → Patient/${p.id} (${p.first} ${p.last})` : ""}`);
  }

  // 3) Enable scheduling for every imported practitioner.
  const practitioners = await medplum.searchResources("Practitioner", { _count: "100" });
  let totalSlots = 0;
  for (const prac of practitioners) {
    const n = await enableScheduling(medplum, prac);
    totalSlots += n;
    const nm = prac.name?.[0];
    console.log(`  scheduled ${nm?.given?.join(" ") ?? ""} ${nm?.family ?? ""} → ${n} slots`);
  }

  // 4) Insurance: 4 living patients → managed care (with assigned PCP), rest → FFS.
  const coverage = await seedCoverage(medplum);
  console.log(
    `  coverage → ${coverage.managed} managed care, ${coverage.ffs} fee-for-service (${coverage.withPcp} with assigned PCP)`,
  );

  // 5) Care templates so the provider app can book visits.
  const templates = await seedCareTemplates(medplum);
  console.log(`  care templates → ${templates} created`);

  // 6) Emit the Watchman identity file (Senzing JSONL, RECORD_ID = Patient id).
  const living = seeded.filter((p) => !p.deceased);
  mkdirSync("seed-output", { recursive: true });
  writeFileSync(OUT_JSONL, `${living.map(senzingLine).join("\n")}\n`, "utf8");

  console.log("\n=== seed complete ===");
  console.log(`patients imported : ${seeded.length} (${living.length} living)`);
  console.log(`practitioners     : ${practitioners.length} (each with a schedule)`);
  console.log(`slots created     : ${totalSlots}`);
  console.log(`coverage          : ${coverage.managed} managed care + ${coverage.ffs} FFS`);
  console.log(`care templates    : ${CARE_TEMPLATES.length} total`);
  console.log(`watchman file     : ${OUT_JSONL} (${living.length} records)`);
}

// Run main() only when invoked directly (`bun run scripts/seed.ts`); importing this
// module (e.g. to apply just coverage/templates to a live DB) does not re-import.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { authenticate };
