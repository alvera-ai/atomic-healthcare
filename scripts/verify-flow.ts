/**
 * verify-flow.ts — the end-to-end identity → chart sequence the agent runs.
 *
 *   bun run scripts/verify-flow.ts
 *
 * 1. WATCHMAN: caller states name + DOB (+ phone tie-breaker) → fuzzy match.
 *    We require a confidence ≥ 92% before trusting the identity.
 * 2. The matched record's RECORD_ID *is* the Medplum Patient id (set at seed time).
 * 3. MOSS: query that patient's pre-seeded chart index (chart-{patientId}).
 */

import { MossClient, mossSettingsFromEnv } from "../src/moss.ts";

const WATCHMAN = process.env.WATCHMAN_URL ?? "http://localhost:8084";
const THRESHOLD = 0.92;

// The caller, as heard on the phone.
const CALLER = { name: "Andrea Ramos", birthDate: "1942-08-11", phone: "555-654-2757" };

function summarize(jsonText: string): string {
  let r: { resourceType?: string; code?: { text?: string; coding?: { display?: string }[] }; clinicalStatus?: { coding?: { code?: string }[] }; onsetDateTime?: string };
  try {
    r = JSON.parse(jsonText);
  } catch {
    return jsonText.slice(0, 80);
  }
  const code = r.code?.text ?? r.code?.coding?.[0]?.display ?? "";
  const status = r.clinicalStatus?.coding?.[0]?.code ?? "";
  return `${r.resourceType} | ${code}${status ? ` [${status}]` : ""}`;
}

async function main(): Promise<void> {
  // 1) WATCHMAN — resolve the caller.
  const params = new URLSearchParams({ type: "person", ...CALLER });
  const res = await fetch(`${WATCHMAN}/v2/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Watchman search failed: ${res.status}`);
  const body = (await res.json()) as { entities?: Array<{ name: string; match: number; sourceID: string }> };

  const top = body.entities?.[0];
  console.log("① WATCHMAN call");
  console.log(`   caller said: "${CALLER.name}", DOB ${CALLER.birthDate}`);
  if (!top) throw new Error("   no match — would ask the caller to repeat / give more details");
  console.log(`   top match : ${top.name}  →  ${(top.match * 100).toFixed(1)}% confidence`);

  if (top.match < THRESHOLD) {
    throw new Error(`   ${(top.match * 100).toFixed(1)}% < ${THRESHOLD * 100}% — NOT confident; agent would ask for another identifier`);
  }
  console.log(`   ✓ identity confirmed (≥ ${THRESHOLD * 100}%)`);

  // 2) RECORD_ID == Medplum Patient id (the bridge between the two systems).
  const patientId = top.sourceID;
  console.log(`\n② BRIDGE  Watchman RECORD_ID = Medplum Patient id = ${patientId}`);

  // 3) MOSS — query the pre-seeded chart index for this patient.
  const moss = new MossClient(mossSettingsFromEnv());
  const idx = `chart-${patientId}`;
  await moss.loadIndex(idx);
  const hits = await moss.query(idx, "active chronic conditions and diagnoses", 4);
  console.log(`\n③ MOSS  query ${idx} — "active chronic conditions":`);
  for (const h of hits) console.log(`   [${h.score.toFixed(2)}] ${summarize(h.text)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
