/**
 * seed-benchmarks.ts — pre-seed Moss with GLOBAL payer eligibility/authorization
 * turnaround benchmarks, so the agent can derive a new patient's verification
 * block-out window by fuzzy-matching their stated insurance to the closest payer.
 *
 *   bun run scripts/seed-benchmarks.ts        # → Moss index `prior-auth-benchmarks`
 *
 * WHY: managed care already uses the FL contract SLA (7 days). For a NEW patient the
 * verification wait depends on the INDIVIDUAL payer. We don't have a per-payer SLA
 * for every insurer, so we seed PUBLIC, GLOBAL benchmarks and let the agent match the
 * caller's spoken insurance to the nearest entry (semantic search) and read its
 * recommended block-out window.
 *
 * Each doc is natural-language (so a spoken payer name retrieves it) and carries a
 * machine-readable `block_out_days` in metadata — the number the agent feeds to
 * find_earliest_appointment(patientId, earliestAfterDays).
 *
 * SOURCES (public, aggregate — these are benchmarks, not contractual SLAs):
 *  - CAQH Index 2023: eligibility & benefit verification is near-real-time when
 *    electronic (270/271), but ~1 in 5 checks are still manual; prior auth is only
 *    ~31% fully electronic, so manual PA dominates turnaround.
 *  - KFF 2024 Medicare Advantage prior-authorization analysis: insurers approve the
 *    large majority of requests; denial RATES (not days) are the published metric —
 *    used here only as a proxy for "this payer is stricter / slower".
 *  - CMS rules on decision TIMES: Medicare Advantage standard organization
 *    determination 14 calendar days (expedited 72h); CMS-0057-F shortens impacted
 *    payers (MA, Medicaid, CHIP, QHP) to a 7-day standard / 72h expedited from 2026.
 *  - 42 CFR 438.210: Medicaid managed-care standard authorization within 7 days.
 */

import { MossClient, mossSettingsFromEnv } from "../src/moss.ts";
import type { MossDoc } from "../src/moss-doc.ts";

const INDEX = process.env.BENCHMARKS_INDEX ?? "prior-auth-benchmarks";

interface Benchmark {
  payer: string;
  category: "medicare-ffs" | "medicaid-ffs" | "medicaid-mco" | "medicare-advantage" | "commercial" | "integrated" | "military" | "self-pay" | "default";
  /** Days to block out before the first bookable visit while coverage is verified/authorized. */
  blockOutDays: number;
  /** Words a caller might say that should retrieve this entry. */
  aliases: string[];
  /** Natural-language description (this is what gets embedded + retrieved). */
  text: string;
}

const BENCHMARKS: Benchmark[] = [
  {
    payer: "Medicare (fee-for-service / Original Medicare)",
    category: "medicare-ffs",
    blockOutDays: 7,
    aliases: ["medicare", "original medicare", "traditional medicare", "medicare part a", "medicare part b", "red white and blue card", "cms"],
    text:
      "Original Medicare (fee-for-service Medicare, Parts A and B). Eligibility and benefit verification is effectively real-time for providers through the CMS HETS 270/271 eligibility transaction, and most physician-office services require no prior authorization. New-patient coverage verification is fast; allow a short buffer of about 7 days to confirm enrollment and any secondary/MSP coverage before the first visit. Block-out window: about 7 days.",
  },
  {
    payer: "Medicaid (fee-for-service / state Medicaid)",
    category: "medicaid-ffs",
    blockOutDays: 14,
    aliases: ["medicaid", "straight medicaid", "state medicaid", "fee for service medicaid", "medi-cal", "ahcccs", "title 19"],
    text:
      "State Medicaid fee-for-service. Eligibility can be checked electronically, but enrollment status and retroactive eligibility are state-dependent and frequently require manual confirmation, and FFS prior authorization is largely manual. Verification turnaround is among the slowest of the major payers. Block-out window: about 14 days.",
  },
  {
    payer: "Medicaid managed care plan (Medicaid HMO / MCO)",
    category: "medicaid-mco",
    blockOutDays: 7,
    aliases: ["medicaid managed care", "medicaid hmo", "medicaid mco", "managed medicaid", "molina", "sunshine health", "simply healthcare", "staywell", "amerigroup medicaid", "wellcare medicaid"],
    text:
      "Medicaid managed-care organization (a Medicaid HMO/MCO). Federal rule 42 CFR 438.210 requires a standard authorization decision within 7 calendar days (expedited within 48-72 hours), and CMS-0057-F holds impacted payers to a 7-day standard decision from 2026. Verification and authorization are bounded by these SLAs. Block-out window: about 7 days.",
  },
  {
    payer: "Medicare Advantage (Part C, Medicare HMO/PPO)",
    category: "medicare-advantage",
    blockOutDays: 14,
    aliases: ["medicare advantage", "part c", "medicare hmo", "medicare ppo", "advantage plan", "humana medicare", "aetna medicare", "unitedhealthcare medicare", "uhc medicare advantage"],
    text:
      "Medicare Advantage (Medicare Part C, a private Medicare HMO or PPO). Standard organization determinations are due within 14 calendar days today (expedited within 72 hours); CMS-0057-F shortens this to a 7-day standard decision for impacted payers from 2026. Prior authorization is used more heavily than in Original Medicare. Block-out window: about 14 days (trending toward 7 under CMS-0057).",
  },
  {
    payer: "UnitedHealthcare (commercial)",
    category: "commercial",
    blockOutDays: 10,
    aliases: ["unitedhealthcare", "united healthcare", "uhc", "united health", "optum", "umr"],
    text:
      "UnitedHealthcare commercial plan. Eligibility verification is electronic and quick, but commercial prior authorization is only partly automated; standard determinations typically take several business days and there is no single federal turnaround mandate for commercial coverage. Block-out window: about 10 days.",
  },
  {
    payer: "Aetna (commercial)",
    category: "commercial",
    blockOutDays: 10,
    aliases: ["aetna", "aetna cvs", "cvs health"],
    text:
      "Aetna commercial plan. Electronic eligibility is quick; commercial prior authorization standard decisions generally take several business days. No federal turnaround mandate applies to commercial coverage. Block-out window: about 10 days.",
  },
  {
    payer: "Cigna (commercial)",
    category: "commercial",
    blockOutDays: 10,
    aliases: ["cigna", "cigna healthcare", "evernorth"],
    text:
      "Cigna commercial plan. Electronic eligibility is quick; commercial prior authorization standard decisions generally take several business days. No federal turnaround mandate applies to commercial coverage. Block-out window: about 10 days.",
  },
  {
    payer: "Blue Cross Blue Shield / Anthem (commercial)",
    category: "commercial",
    blockOutDays: 10,
    aliases: ["blue cross", "blue shield", "bcbs", "anthem", "blue cross blue shield", "florida blue", "elevance"],
    text:
      "Blue Cross Blue Shield / Anthem (Elevance) commercial plan, including state Blues like Florida Blue. Electronic eligibility is quick; commercial prior authorization standard decisions generally take several business days, varying by local Blue plan. Block-out window: about 10 days.",
  },
  {
    payer: "Humana (commercial)",
    category: "commercial",
    blockOutDays: 10,
    aliases: ["humana", "humana commercial"],
    text:
      "Humana commercial plan. Electronic eligibility is quick; commercial prior authorization standard decisions generally take several business days. Block-out window: about 10 days.",
  },
  {
    payer: "Kaiser Permanente (integrated)",
    category: "integrated",
    blockOutDays: 7,
    aliases: ["kaiser", "kaiser permanente", "kp"],
    text:
      "Kaiser Permanente, an integrated payer-provider. Eligibility and authorization are handled within one system, so verification is typically faster than external commercial payers. Block-out window: about 7 days.",
  },
  {
    payer: "TRICARE (military)",
    category: "military",
    blockOutDays: 10,
    aliases: ["tricare", "military insurance", "champva", "va insurance", "humana military"],
    text:
      "TRICARE (military health coverage). Eligibility is verifiable through DEERS, but referrals/authorizations for non-network civilian care add a few business days. Block-out window: about 10 days.",
  },
  {
    payer: "Self-pay / uninsured (no coverage to verify)",
    category: "self-pay",
    blockOutDays: 0,
    aliases: ["self pay", "self-pay", "no insurance", "uninsured", "cash", "out of pocket", "none", "paying myself"],
    text:
      "Self-pay or uninsured — there is no third-party coverage to verify or authorize, so no verification delay is needed. Block-out window: 0 days (book the earliest available slot).",
  },
  {
    payer: "Unknown / other commercial payer",
    category: "default",
    blockOutDays: 15,
    aliases: ["other", "not sure", "unknown", "i don't know", "private insurance", "employer insurance"],
    text:
      "Fallback benchmark for an unrecognized or unstated commercial payer. With no payer-specific SLA, use a conservative fee-for-service verification window. Block-out window: about 15 days.",
  },
];

function toDocs(benchmarks: Benchmark[]): MossDoc[] {
  return benchmarks.map((b, i) => ({
    id: `benchmark-${b.category}-${i}`,
    // Lead with the payer + aliases so a spoken insurance name retrieves the entry.
    text: `Payer: ${b.payer}. Also known as: ${b.aliases.join(", ")}.\n${b.text}`,
    metadata: {
      payer: b.payer,
      category: b.category,
      block_out_days: String(b.blockOutDays),
      source: "CAQH Index 2023; KFF 2024 MA prior auth; CMS-0057-F; 42 CFR 438.210",
    },
  }));
}

async function main(): Promise<void> {
  const moss = new MossClient(mossSettingsFromEnv());
  const docs = toDocs(BENCHMARKS);
  console.log(`seeding ${docs.length} payer benchmarks → Moss index "${INDEX}"…`);
  await moss.upsertIndex(INDEX, docs);
  for (const i of await moss.listIndexes()) {
    if (i.name === INDEX) console.log(`\nindex "${i.name}": ${i.docCount} docs [${i.status}]`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
