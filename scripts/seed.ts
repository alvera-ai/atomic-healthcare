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
  Patient,
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
  const p = entries[idx].resource as Patient;
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

/** Create a Schedule for a practitioner and free 30-min slots, 9:00–12:00, next 10 weekdays. */
async function enableScheduling(
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
    for (let hour = 9; hour < 12; hour++) {
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

  // 4) Emit the Watchman identity file (Senzing JSONL, RECORD_ID = Patient id).
  const living = seeded.filter((p) => !p.deceased);
  mkdirSync("seed-output", { recursive: true });
  writeFileSync(OUT_JSONL, `${living.map(senzingLine).join("\n")}\n`, "utf8");

  console.log("\n=== seed complete ===");
  console.log(`patients imported : ${seeded.length} (${living.length} living)`);
  console.log(`practitioners     : ${practitioners.length} (each with a schedule)`);
  console.log(`slots created     : ${totalSlots}`);
  console.log(`watchman file     : ${OUT_JSONL} (${living.length} records)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
