/**
 * moss-doc.ts — the Moss document shape.
 *
 * Moss (@moss-dev/moss) ingests an array of `DocumentInfo`: each is a chunk of
 * natural-language `text` (what gets embedded + retrieved) plus string-only
 * `metadata` (for filtering, e.g. by patient_id or category), with a stable `id`.
 *
 * We define it locally so this module is runnable without the Moss SDK installed.
 * It is wire-compatible with `@moss-dev/moss`'s `DocumentInfo` — when we wire real
 * ingestion we can `import type { DocumentInfo } from "@moss-dev/moss"` instead.
 */
export interface MossDoc {
  id: string;
  text: string;
  metadata: Record<string, string>;
}
