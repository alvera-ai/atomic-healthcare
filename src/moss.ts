/**
 * moss.ts — thin wrapper over the Moss SDK (@moss-dev/moss).
 *
 * Moss is the retrieval layer: we push a patient's chart as documents into a
 * per-patient index (chart-{patientId}) and the agent queries it during a call.
 * Mutations (createIndex/addDocs) are async cloud jobs, but the SDK already
 * awaits job completion — when these methods resolve, the index is ready.
 *
 * Config from .env (Bun auto-loads): MOSS_PROJECT_ID, MOSS_PROJECT_KEY.
 */

import { MossClient as SdkMossClient } from "@moss-dev/moss";
import type { MossDoc } from "./moss-doc.ts";

export interface MossSettings {
  projectId: string;
  projectKey: string;
}

export function mossSettingsFromEnv(): MossSettings {
  const projectId = process.env.MOSS_PROJECT_ID;
  const projectKey = process.env.MOSS_PROJECT_KEY;
  if (!projectId || !projectKey) {
    throw new Error("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env");
  }
  return { projectId, projectKey };
}

export class MossClient {
  private readonly client: SdkMossClient;

  constructor(settings: MossSettings) {
    this.client = new SdkMossClient(settings.projectId, settings.projectKey);
  }

  /**
   * Create the index if it's new, otherwise upsert the docs. Idempotent, so
   * re-running seed-moss (or re-loading a chart mid-call) is safe.
   */
  async upsertIndex(indexName: string, docs: MossDoc[]): Promise<void> {
    if (docs.length === 0) throw new Error(`refusing to index empty docs into ${indexName}`);

    // A chart can be thousands of resources; push in batches so payloads stay sane.
    const BATCH = 1000;
    const exists = (await this.client.listIndexes()).some((i) => i.name === indexName);

    let start = 0;
    if (!exists) {
      await this.client.createIndex(indexName, docs.slice(0, BATCH));
      start = BATCH;
    }
    for (let i = start; i < docs.length; i += BATCH) {
      await this.client.addDocs(indexName, docs.slice(i, i + BATCH), { upsert: true });
    }
  }

  /** Download an index into memory for fast, reliable in-process querying. */
  async loadIndex(indexName: string): Promise<void> {
    await this.client.loadIndex(indexName);
  }

  /** List all indexes in the project (name + docCount + status). */
  async listIndexes(): Promise<Array<{ name: string; docCount: number; status: string }>> {
    const indexes = await this.client.listIndexes();
    return indexes.map((i) => ({ name: i.name, docCount: i.docCount, status: String(i.status) }));
  }

  /** Semantic search over an index (used by the agent during a call, and to verify). */
  async query(
    indexName: string,
    text: string,
    topK = 5,
  ): Promise<Array<{ id: string; text: string; score: number }>> {
    const result = await this.client.query(indexName, text, { topK });
    return result.docs.map((d) => ({ id: d.id, text: d.text, score: d.score }));
  }
}
