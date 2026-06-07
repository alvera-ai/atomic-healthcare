/**
 * chart-to-moss.ts — turn a FHIR `$everything` Bundle into Moss documents.
 *
 * Design (per the "1 patient = 1 index" decision): the caller puts these docs in
 * an index named `chart-{patientId}`, so NO patient_id filter is needed at query
 * time — the index itself is the isolation boundary.
 *
 * We emit ONE doc per clinical CATEGORY (problems, medications, allergies, labs,
 * vitals, immunizations, procedures, encounters, coverage), not one per resource.
 * Category-sized chunks retrieve well for a voice agent ("what meds is she on?"
 * → the whole medication list comes back as one coherent chunk), and they keep a
 * chart with thousands of Observations down to a handful of useful documents.
 */

import type {
  AllergyIntolerance,
  Bundle,
  CodeableConcept,
  Condition,
  Coverage,
  Encounter,
  Immunization,
  MedicationRequest,
  Observation,
  Patient,
  Procedure,
  Resource,
} from "@medplum/fhirtypes";
import type { MossDoc } from "./moss-doc.ts";

/** Best human-readable label out of a CodeableConcept. */
function label(concept: CodeableConcept | undefined): string {
  return (
    concept?.text ??
    concept?.coding?.find((c) => c.display)?.display ??
    concept?.coding?.[0]?.code ??
    "unknown"
  );
}

/** Pick the most relevant date off a resource, as YYYY-MM-DD. */
function dateOf(value: string | undefined): string {
  return value ? value.slice(0, 10) : "";
}

/** All resources of a given type from the bundle. */
function pick<T extends Resource>(bundle: Bundle, type: T["resourceType"]): T[] {
  return (bundle.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is T => r?.resourceType === type);
}

/** Build one MossDoc if there are any lines; otherwise null (skip empty categories). */
function doc(
  patientId: string,
  category: string,
  title: string,
  lines: string[],
): MossDoc | null {
  if (lines.length === 0) return null;
  return {
    id: `chart-${patientId}-${category}`,
    text: `${title}\n${lines.map((l) => `- ${l}`).join("\n")}`,
    metadata: {
      patient_id: patientId,
      category,
      source: "medplum",
      count: String(lines.length),
    },
  };
}

/**
 * Collapse repeated resources (e.g. 22 refills of the same drug) into one entry.
 * Keyed by `keyFn`; the representative kept is the one with the highest `priority`
 * (e.g. an active record beats a completed one). Returns [key, representative,
 * count] tuples sorted by priority descending.
 */
function dedupeBy<T>(
  items: T[],
  keyFn: (item: T) => string,
  priority: (item: T) => number,
): Array<[string, T, number]> {
  const map = new Map<string, { rep: T; prio: number; count: number }>();
  for (const item of items) {
    const key = keyFn(item);
    const prio = priority(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { rep: item, prio, count: 1 });
    } else {
      existing.count += 1;
      if (prio > existing.prio) {
        existing.rep = item;
        existing.prio = prio;
      }
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1].prio - a[1].prio)
    .map(([key, v]) => [key, v.rep, v.count] as [string, T, number]);
}

/** For Observations: keep only the latest value per distinct code (current labs/vitals). */
function latestPerCode(observations: Observation[]): Observation[] {
  const byCode = new Map<string, Observation>();
  for (const o of observations) {
    const key = o.code?.coding?.[0]?.code ?? label(o.code);
    const when = o.effectiveDateTime ?? "";
    const existing = byCode.get(key);
    if (!existing || when > (existing.effectiveDateTime ?? "")) {
      byCode.set(key, o);
    }
  }
  return [...byCode.values()];
}

/** Render an Observation value (Quantity, CodeableConcept, or string). */
function obsValue(o: Observation): string {
  if (o.valueQuantity) {
    return `${o.valueQuantity.value ?? "?"} ${o.valueQuantity.unit ?? ""}`.trim();
  }
  if (o.valueCodeableConcept) return label(o.valueCodeableConcept);
  if (typeof o.valueString === "string") return o.valueString;
  return "(recorded)";
}

/**
 * Transform a `$everything` Bundle into category-grouped Moss documents for the
 * index `chart-{patientId}`.
 */
export function chartToMossDocs(patientId: string, bundle: Bundle): MossDoc[] {
  const docs: (MossDoc | null)[] = [];

  // Demographics (one short doc) -------------------------------------------
  const patient = pick<Patient>(bundle, "Patient")[0];
  if (patient) {
    const name = patient.name?.[0];
    const addr = patient.address?.[0];
    docs.push(
      doc(patientId, "demographics", "Patient demographics:", [
        `Name: ${name?.given?.join(" ") ?? ""} ${name?.family ?? ""}`.trim(),
        `DOB: ${patient.birthDate ?? "unknown"}  Gender: ${patient.gender ?? "unknown"}`,
        addr ? `Address: ${[addr.line?.join(" "), addr.city, addr.state, addr.postalCode].filter(Boolean).join(", ")}` : "",
        `Phone: ${patient.telecom?.find((t) => t.system === "phone")?.value ?? "unknown"}`,
      ].filter(Boolean)),
    );
  }

  // Problems (deduped by condition; active first) ---------------------------
  const problems = dedupeBy(
    pick<Condition>(bundle, "Condition"),
    (c) => label(c.code),
    (c) => (c.clinicalStatus?.coding?.[0]?.code === "active" ? 2 : 1),
  );
  docs.push(
    doc(
      patientId,
      "problems",
      "Problems / conditions:",
      problems.map(([name, c, n]) => {
        const status = c.clinicalStatus?.coding?.[0]?.code ?? "";
        return `${name}${status ? ` (${status})` : ""}${n > 1 ? ` ×${n}` : ""}`;
      }),
    ),
  );

  // Medications (deduped by drug; active first, fill count kept) -------------
  const meds = dedupeBy(
    pick<MedicationRequest>(bundle, "MedicationRequest"),
    (m) => label(m.medicationCodeableConcept),
    (m) => (m.status === "active" ? 2 : 1),
  );
  docs.push(
    doc(
      patientId,
      "medications",
      "Medications:",
      meds.map(([name, m, n]) => {
        const dose = m.dosageInstruction?.[0]?.text;
        const status = m.status ?? "";
        return `${name}${dose ? ` — ${dose}` : ""}${status ? ` [${status}]` : ""}${n > 1 ? ` (${n} fills)` : ""}`;
      }),
    ),
  );

  // Allergies ---------------------------------------------------------------
  docs.push(
    doc(
      patientId,
      "allergies",
      "Allergies:",
      pick<AllergyIntolerance>(bundle, "AllergyIntolerance").map((a) => {
        const crit = a.criticality ? ` (criticality ${a.criticality})` : "";
        return `${label(a.code)}${crit}`;
      }),
    ),
  );

  // Labs (latest per code) --------------------------------------------------
  const labs = pick<Observation>(bundle, "Observation").filter((o) =>
    o.category?.some((c) => c.coding?.some((cc) => cc.code === "laboratory")),
  );
  docs.push(
    doc(
      patientId,
      "labs",
      "Recent laboratory results (latest per test):",
      latestPerCode(labs).map((o) => {
        const when = dateOf(o.effectiveDateTime);
        return `${label(o.code)}: ${obsValue(o)}${when ? ` (${when})` : ""}`;
      }),
    ),
  );

  // Vitals (latest per code) ------------------------------------------------
  const vitals = pick<Observation>(bundle, "Observation").filter((o) =>
    o.category?.some((c) => c.coding?.some((cc) => cc.code === "vital-signs")),
  );
  docs.push(
    doc(
      patientId,
      "vitals",
      "Most recent vital signs:",
      latestPerCode(vitals).map((o) => {
        const when = dateOf(o.effectiveDateTime);
        return `${label(o.code)}: ${obsValue(o)}${when ? ` (${when})` : ""}`;
      }),
    ),
  );

  // Immunizations -----------------------------------------------------------
  docs.push(
    doc(
      patientId,
      "immunizations",
      "Immunizations:",
      pick<Immunization>(bundle, "Immunization").map(
        (i) => `${label(i.vaccineCode)}${i.occurrenceDateTime ? ` (${dateOf(i.occurrenceDateTime)})` : ""}`,
      ),
    ),
  );

  // Procedures --------------------------------------------------------------
  docs.push(
    doc(
      patientId,
      "procedures",
      "Procedures:",
      pick<Procedure>(bundle, "Procedure").map(
        (p) => `${label(p.code)}${p.performedDateTime ? ` (${dateOf(p.performedDateTime)})` : ""}`,
      ),
    ),
  );

  // Encounters (visit history) ---------------------------------------------
  docs.push(
    doc(
      patientId,
      "encounters",
      "Visit history:",
      pick<Encounter>(bundle, "Encounter")
        .sort((a, b) => (b.period?.start ?? "").localeCompare(a.period?.start ?? ""))
        .map((e) => {
          const when = dateOf(e.period?.start);
          return `${when ? `${when}: ` : ""}${label(e.type?.[0])}${e.status ? ` [${e.status}]` : ""}`;
        }),
    ),
  );

  // Coverage (insurance) ----------------------------------------------------
  docs.push(
    doc(
      patientId,
      "coverage",
      "Insurance coverage:",
      pick<Coverage>(bundle, "Coverage").map((c) => {
        const payor = c.class?.find((cl) => cl.name)?.name ?? label(c.type);
        return `${payor}${c.status ? ` [${c.status}]` : ""}`;
      }),
    ),
  );

  return docs.filter((d): d is MossDoc => d !== null);
}
