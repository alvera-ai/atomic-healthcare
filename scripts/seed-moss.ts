/**
 * seed-moss.ts — pre-warm Moss with patient charts, the same way `make seed` loads
 * patients into Medplum/Watchman.
 *
 *   bun run scripts/seed-moss.ts                 # all living patients (from patients.jsonl)
 *   bun run scripts/seed-moss.ts <patientId>     # just one (fast, for verifying)
 *
 * Each patient becomes its own index chart-{patientId} (1 patient = 1 index). The
 * per-patient chart docs come from the SAME MedplumClient.getChartForMoss() the
 * LiveKit agent calls at runtime — seed-time and call-time share one code path.
 */

import { MedplumClient, settingsFromEnv } from "../src/medplum.ts";
import { MossClient, mossSettingsFromEnv } from "../src/moss.ts";

async function main(): Promise<void> {
  const medplum = new MedplumClient(settingsFromEnv());
  const moss = new MossClient(mossSettingsFromEnv());

  const arg = process.argv[2];
  const ids = arg ? [arg] : await medplum.listPatientIds();
  console.log(`indexing ${ids.length} patient chart(s) into Moss…\n`);

  for (const id of ids) {
    const { indexName, docs } = await medplum.getChartForMoss(id);
    await moss.upsertIndex(indexName, docs);
    console.log(`  ✓ ${indexName}  (${docs.length} docs)`);
  }

  console.log("\nMoss indexes now in the project:");
  for (const i of await moss.listIndexes()) {
    console.log(`  ${i.name.padEnd(48)} ${i.docCount} docs  [${i.status}]`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
