/**
 * chart-to-moss.ts — turn a chart Bundle into Moss documents.
 *
 * ONE doc per FHIR resource, verbatim. No summarizing, no dedup: the raw resource
 * IS the text (its display strings drive the embedding) and also rides in metadata
 * for the agent to read exactly. Retrieval + topK selects at query time — nothing is
 * pre-discarded, so history is preserved (e.g. every blood-pressure reading, not just
 * the latest). Indexes are built offline (`seed-moss`), so document volume is never on
 * the call path.
 */

import type { Bundle } from "@medplum/fhirtypes";
import type { MossDoc } from "./moss-doc.ts";

/** Best-available clinical date on a resource, for metadata filtering/sorting. */
function resourceDate(r: Record<string, unknown> & { period?: { start?: string }; billablePeriod?: { start?: string }; meta?: { lastUpdated?: string } }): string {
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

export function chartToMossDocs(patientId: string, bundle: Bundle): MossDoc[] {
  const docs: MossDoc[] = [];
  for (const entry of bundle.entry ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = entry.resource as any;
    if (!r?.resourceType || !r?.id) continue;
    docs.push({
      id: `${r.resourceType}/${r.id}`,
      text: JSON.stringify(r),
      metadata: {
        patient_id: patientId,
        resource_type: r.resourceType,
        date: resourceDate(r),
      },
    });
  }
  return docs;
}
