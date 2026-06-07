/**
 * unsiloed.ts — thin wrapper over Unsiloed's document-parsing API.
 *
 * Unsiloed turns an unstructured contract PDF into layout-aware chunks (tables stay
 * tables, sections grouped). We use it for the contracts knowledge base — the
 * structured counterpart to the chart pipeline. Async submit-and-poll:
 *   POST /parse (multipart file) → { job_id }
 *   GET  /parse/{job_id} → poll until status "Succeeded" → chunks[].segments[]
 *
 * Config from .env: UNSILOED_API_KEY (header `api-key`).
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export interface UnsiloedSettings {
  apiKey: string;
  baseUrl: string;
}

export function unsiloedSettingsFromEnv(): UnsiloedSettings {
  const apiKey = process.env.UNSILOED_API_KEY;
  if (!apiKey) throw new Error("Set UNSILOED_API_KEY in .env");
  return { apiKey, baseUrl: process.env.UNSILOED_BASE_URL ?? "https://prod.visionapi.unsiloed.ai" };
}

export interface UnsiloedSegment {
  segment_type?: string;
  content?: string;
  markdown?: string;
  page_number?: number;
}
export interface UnsiloedChunk {
  segments?: UnsiloedSegment[];
}

export class UnsiloedClient {
  constructor(private readonly settings: UnsiloedSettings) {}

  /** Parse a local PDF: submit, poll to completion, return its chunks. */
  async parseFile(filePath: string): Promise<UnsiloedChunk[]> {
    const bytes = readFileSync(filePath);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/pdf" }), basename(filePath));
    form.append("segment_filter", "all");

    const submit = await fetch(`${this.settings.baseUrl}/parse`, {
      method: "POST",
      headers: { "api-key": this.settings.apiKey },
      body: form,
    });
    if (!submit.ok) {
      throw new Error(`Unsiloed submit failed: ${submit.status} ${await submit.text()}`);
    }
    const { job_id: jobId } = (await submit.json()) as { job_id: string };

    // Poll up to ~25 minutes (large multi-hundred-page contracts parse slowly).
    for (let i = 0; i < 300; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const res = await fetch(`${this.settings.baseUrl}/parse/${jobId}`, {
        headers: { "api-key": this.settings.apiKey },
      });
      if (!res.ok) throw new Error(`Unsiloed poll failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { status: string; chunks?: UnsiloedChunk[] };
      if (body.status === "Succeeded") return body.chunks ?? [];
      if (body.status === "Failed") throw new Error(`Unsiloed parse failed for ${basename(filePath)}`);
    }
    throw new Error(`Unsiloed parse timed out for ${basename(filePath)}`);
  }
}
