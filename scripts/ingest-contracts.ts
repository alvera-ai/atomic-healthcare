/**
 * ingest-contracts.ts — parse the Florida Medicaid managed-care contract PDFs with
 * Unsiloed and push the chunks into a shared Moss knowledge index.
 *
 *   make fetch-contracts      # download the PDFs into data/contracts/ (one time)
 *   bun run ingest-contracts  # Unsiloed parse → Moss careops-fl-contracts
 *
 * One Moss doc per Unsiloed chunk: text = the chunk's segments (markdown/text)
 * joined; metadata carries the source file + page so the agent can cite the policy.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MossClient, mossSettingsFromEnv } from "../src/moss.ts";
import type { MossDoc } from "../src/moss-doc.ts";
import { type UnsiloedChunk, UnsiloedClient, unsiloedSettingsFromEnv } from "../src/unsiloed.ts";

const DIR = process.env.CONTRACTS_DIR ?? "data/contracts";
const INDEX = process.env.CONTRACTS_INDEX ?? "florida-managed-care";

function chunksToDocs(file: string, chunks: UnsiloedChunk[]): MossDoc[] {
  const docs: MossDoc[] = [];
  chunks.forEach((c, i) => {
    const segs = c.segments ?? [];
    const text = segs
      .map((s) => s.markdown || s.content || "")
      .map((t) => t.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) return;
    const page = segs.find((s) => s.page_number != null)?.page_number;
    docs.push({
      id: `${file}-chunk-${i}`,
      text,
      metadata: {
        source: file,
        state: "FL",
        program: "medicaid-managed-care",
        ...(page != null ? { page: String(page) } : {}),
      },
    });
  });
  return docs;
}

async function main(): Promise<void> {
  const unsiloed = new UnsiloedClient(unsiloedSettingsFromEnv());
  const moss = new MossClient(mossSettingsFromEnv());

  const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) throw new Error(`no PDFs in ${DIR} — run \`make fetch-contracts\` first`);

  // Parse + push ONE FILE AT A TIME so a slow/failed PDF can't lose the others.
  // Doc ids are `${file}-chunk-${i}`, so upsert makes re-runs idempotent.
  for (const f of files) {
    try {
      console.log(`parsing ${f} via Unsiloed…`);
      const chunks = await unsiloed.parseFile(join(DIR, f));
      const docs = chunksToDocs(f, chunks);
      if (docs.length === 0) {
        console.log(`  0 docs — skipping`);
        continue;
      }
      await moss.upsertIndex(INDEX, docs);
      console.log(`  ✓ ${chunks.length} chunks → ${docs.length} docs → ${INDEX}`);
    } catch (err) {
      console.log(`  ✗ FAILED ${f}: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
  }

  for (const i of await moss.listIndexes()) {
    if (i.name === INDEX) console.log(`\nindex "${i.name}": ${i.docCount} docs [${i.status}]`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
