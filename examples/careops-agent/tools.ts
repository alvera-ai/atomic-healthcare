/**
 * tools.ts — the agent's llm.tool()s. Each is a thin call into a src/ wrapper.
 * No MCP, no HTTP tool server — in-process functions, the wrapper's limited API
 * is the safety boundary.
 */

import { llm } from "@livekit/agents";
import { z } from "zod";
import { MedplumClient, settingsFromEnv } from "../../src/medplum.ts";
import { MossClient, mossSettingsFromEnv } from "../../src/moss.ts";
import { WatchmanClient, watchmanSettingsFromEnv } from "../../src/watchman.ts";

const CONFIDENCE_GATE = 0.9;
const BENCHMARKS_INDEX = "prior-auth-benchmarks";
const DEFAULT_BLOCK_OUT_DAYS = 15; // conservative fallback if no benchmark matches

/** Shared per-call state — lets main.ts write the transcript to the right patient on hangup. */
export interface CallState {
  patientId?: string;
  /** The appointment booked this call. Set once; re-used so an interrupted/re-issued
   *  tool call can't double-book (LiveKit drops a tool's output on interruption and
   *  the LLM then re-calls it). */
  booking?: { appointmentId: string; start: string; via: string };
}

export function careopsTools(callState: CallState = {}) {
  const medplum = new MedplumClient(settingsFromEnv());
  const moss = new MossClient(mossSettingsFromEnv());
  const watchman = new WatchmanClient(watchmanSettingsFromEnv());
  const loaded = new Set<string>(); // Moss indexes already pulled into memory this call

  return {
    /** Identity gate — Watchman fuzzy match, trusted only at ≥ 90%. */
    resolve_patient: llm.tool({
      description:
        "Identify the caller from their spoken name and date of birth (optionally phone or address as tie-breakers). " +
        "Returns the best match and a confidence between 0 and 1. Only trust a match when confidence is at least 0.90.",
      parameters: z.object({
        name: z.string().describe("Caller's full name."),
        birthDate: z.string().optional().describe("Date of birth, YYYY-MM-DD."),
        phone: z.string().optional().describe("Phone number — a tie-breaker if confidence is low."),
        address: z.string().optional().describe("Street address — a tie-breaker if confidence is low."),
      }),
      execute: async ({ name, birthDate, phone, address }) => {
        console.error(`[resolve_patient] →`, { name, birthDate, phone, address });
        const matches = await watchman.resolvePatient({ name, birthDate, phone, address });
        const top = matches[0];
        console.error(`[resolve_patient] ←`, top ? `${top.name} ${(top.confidence * 100).toFixed(0)}%` : "no match");
        if (!top) {
          return { matched: false, message: "No patient found. Offer to register the caller as a new patient." };
        }
        const confident = top.confidence >= CONFIDENCE_GATE;
        if (confident) callState.patientId = top.patientId;
        return {
          matched: confident,
          confidence: Number(top.confidence.toFixed(2)),
          name: top.name,
          patientId: confident ? top.patientId : undefined,
          message: confident
            ? "Identity confirmed."
            : "Below 0.90 confidence — ask for one more identifier (phone or address) and try again, or offer to register.",
        };
      },
    }),

    /** Pull facts from the verified patient's pre-seeded Moss chart index. */
    get_patient_chart: llm.tool({
      description:
        "Look up facts from a verified patient's chart (active conditions, recent labs, medications) to judge how sick they are. " +
        "Call only after resolve_patient confirms identity at ≥ 0.90.",
      parameters: z.object({
        patientId: z.string().describe("Verified Patient id from resolve_patient."),
        question: z.string().describe("What to look up, e.g. 'active chronic conditions and diagnoses'."),
      }),
      execute: async ({ patientId, question }) => {
        const idx = `chart-${patientId}`;
        if (!loaded.has(idx)) {
          await moss.loadIndex(idx);
          loaded.add(idx);
        }
        const hits = await moss.query(idx, question, 6);
        return { facts: hits.map((h) => h.text) };
      },
    }),

    /** Register a new patient when Watchman finds no confident match. */
    create_patient: llm.tool({
      description:
        "Register a brand-new patient when resolve_patient finds no match. Collect first name, last name, and date of birth first; phone is optional.",
      parameters: z.object({
        givenName: z.string().describe("First name."),
        familyName: z.string().describe("Last name."),
        birthDate: z.string().describe("Date of birth, YYYY-MM-DD."),
        phone: z.string().optional().describe("Phone number."),
      }),
      execute: async ({ givenName, familyName, birthDate, phone }) => {
        const patientId = await medplum.createPatient({
          given: givenName,
          family: familyName,
          birthDate,
          phone,
        });
        callState.patientId = patientId;
        return { created: true, patientId, note: "New patient — no chart history yet." };
      },
    }),

    /** Insurance plan (managed care vs fee-for-service) for the verified patient. */
    get_coverage: llm.tool({
      description: "Get the patient's insurance: plan type (managed care vs fee-for-service), payer, and whether it's managed care.",
      parameters: z.object({ patientId: z.string().describe("Verified Patient id.") }),
      execute: async ({ patientId }) => {
        const c = await medplum.getCoverage(patientId);
        return c ?? { plan: "unknown", payer: "", managedCare: false };
      },
    }),

    /** Match a new patient's stated insurance to global benchmarks → block-out days. */
    get_payer_turnaround: llm.tool({
      description:
        "For a NEW patient, look up how long their stated insurance typically takes to verify/authorize, by fuzzy-matching the spoken payer name against global payer benchmarks. " +
        "Returns the matched payer and a recommended block-out window in days — feed that number to find_earliest_appointment(patientId, earliestAfterDays). " +
        "Use this instead of guessing the window. If the caller gives no insurance, pass 'unknown'.",
      parameters: z.object({
        insuranceName: z.string().describe("The insurance/payer the caller stated, e.g. 'Medicare', 'Aetna', 'Florida Blue', 'self pay'. Pass 'unknown' if not given."),
      }),
      execute: async ({ insuranceName }) => {
        if (!loaded.has(BENCHMARKS_INDEX)) {
          await moss.loadIndex(BENCHMARKS_INDEX);
          loaded.add(BENCHMARKS_INDEX);
        }
        const hits = await moss.query(BENCHMARKS_INDEX, insuranceName, 3);
        const top = hits[0];
        // block_out_days lives in the doc text ("Block-out window: about N days"); parse it.
        const m = top?.text.match(/Block-out window:\s*(?:about\s*)?(\d+)\s*days?/i);
        const blockOutDays = m ? Number(m[1]) : DEFAULT_BLOCK_OUT_DAYS;
        const matchedPayer = top?.text.match(/Payer:\s*([^.\n]+)/i)?.[1]?.trim();
        return {
          matchedPayer: matchedPayer ?? "unknown",
          blockOutDays,
          basis: top ? top.text : "No benchmark matched — using a conservative fee-for-service window.",
          note: `Block out about ${blockOutDays} days for ${matchedPayer ?? "this payer"} to verify coverage, then call find_earliest_appointment(patientId, ${blockOutDays}).`,
        };
      },
    }),

    /** Find the earliest open appointment slot, optionally after an eligibility-verification window. */
    find_earliest_appointment: llm.tool({
      description:
        "Find the earliest open appointment slot for a verified patient. Set earliestAfterDays to delay the window: 0 for an existing (already-verified) patient; for a NEW patient use the eligibility/authorization turnaround — 7 days for managed care (FL contract standard-authorization SLA), otherwise the blockOutDays from get_payer_turnaround for their stated insurance. Managed-care patients are matched to their assigned PCP's schedule.",
      parameters: z.object({
        patientId: z.string(),
        earliestAfterDays: z.number().describe("Earliest the appointment may be, in days from today (0, 5, or 15)."),
      }),
      execute: async ({ patientId, earliestAfterDays }) => {
        const cov = await medplum.getCoverage(patientId);
        const practitionerId = cov?.managedCare ? await medplum.getPrimaryPractitionerId(patientId) : undefined;
        const afterISO = new Date(Date.now() + Math.max(0, earliestAfterDays) * 86_400_000).toISOString();
        const slot = await medplum.findEarliestSlot({ afterISO, practitionerId });
        if (!slot) return { found: false, message: "No open slot in that window." };
        return { found: true, slotId: slot.id, start: slot.start };
      },
    }),

    /** Book a specific open slot. */
    book_appointment: llm.tool({
      description: "Book a specific open slot for the patient, using the slotId from find_earliest_appointment.",
      parameters: z.object({ patientId: z.string(), slotId: z.string() }),
      execute: async ({ patientId, slotId }) => {
        if (callState.booking) {
          return { booked: true, ...callState.booking, note: "Already booked this call — not double-booking." };
        }
        const r = await medplum.bookAppointment(patientId, slotId);
        callState.booking = { appointmentId: r.appointmentId, start: r.start, via: "book_appointment" };
        return { booked: true, start: r.start, appointmentId: r.appointmentId };
      },
    }),

    /** Managed-care guarantee: create an after-5pm overflow slot and book it. */
    create_priority_appointment: llm.tool({
      description:
        "Managed-care guarantee for a SICK managed-care patient when find_earliest_appointment found nothing acceptable: create an extra after-hours slot (5 PM or later) on the patient's PCP schedule and book it. Use only in that case. " +
        "If the caller said the earliest they can come is a specific evening time, pass requestedHour (24-hour, e.g. 18 for 6 PM); it is clamped to the 5–8 PM after-hours band.",
      parameters: z.object({
        patientId: z.string(),
        requestedHour: z.number().optional().describe("Caller's earliest after-hours time as a 24-hour hour (17=5pm, 18=6pm, 19=7pm). Omit to default to 5 PM."),
      }),
      execute: async ({ patientId, requestedHour }) => {
        if (callState.booking) {
          return { booked: true, ...callState.booking, note: "Already booked this call — not creating another overflow slot." };
        }
        const r = await medplum.createPrioritySlotAndBook(patientId, { hour: requestedHour });
        if (!r) return { booked: false, message: "No assigned PCP/schedule to add an overflow slot to." };
        callState.booking = { appointmentId: r.appointmentId, start: r.start, via: "create_priority_appointment" };
        return { booked: true, start: r.start, appointmentId: r.appointmentId };
      },
    }),
  };
}
