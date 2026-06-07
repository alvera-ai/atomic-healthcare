/**
 * fetch-chart.ts — run the chart-load wrapper from the terminal, exactly the way
 * the LiveKit agent will call it after Watchman resolves a patient.
 *
 *   bun run src/fetch-chart.ts <patientId>
 *   bun run src/fetch-chart.ts d237938a-c914-419f-9bdd-b8bcd82b7a9b
 *
 * The agent's tool body is essentially these three lines:
 *
 *   const medplum = new MedplumClient(settingsFromEnv());
 *   const { indexName, docs } = await medplum.getChartForMoss(patientId);
 *   await moss.createIndex(indexName, docs);   // (Moss wiring comes next)
 *
 * Here we just print the docs (and optionally write them to a file) so you can
 * read exactly what would be embedded into Moss.
 */

import { writeFileSync } from "node:fs";
import { MedplumClient, settingsFromEnv } from "./medplum.ts";

async function main(): Promise<void> {
  const patientId = process.argv[2];
  if (!patientId) {
    console.error("usage: bun run src/fetch-chart.ts <patientId> [--write]");
    process.exit(1);
  }
  const write = process.argv.includes("--write");

  const medplum = new MedplumClient(settingsFromEnv());

  // This is the exact call the LiveKit tool makes:
  const { indexName, docs } = await medplum.getChartForMoss(patientId);

  console.log(`\nMoss index : ${indexName}`);
  console.log(`documents  : ${docs.length} (one per FHIR resource)\n`);

  // Summary by resource type (printing thousands of raw docs is useless).
  const byType: Record<string, number> = {};
  for (const d of docs) {
    const t = d.metadata.resource_type ?? "?";
    byType[t] = (byType[t] ?? 0) + 1;
  }
  console.log("by resource type:");
  for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(24)} ${n}`);
  }
  console.log("\nsample docs:");
  for (const d of docs.slice(0, 3)) {
    console.log(`  ${d.id}  →  ${d.text.slice(0, 100)}…`);
  }

  if (write) {
    const out = `seed-output/${indexName}.moss.json`;
    writeFileSync(out, `${JSON.stringify(docs, null, 2)}\n`);
    console.log(`wrote ${docs.length} docs → ${out}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
