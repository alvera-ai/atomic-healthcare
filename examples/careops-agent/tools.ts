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

export function careopsTools() {
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

    /** Find the earliest open appointment slot, optionally after an eligibility-verification window. */
    find_earliest_appointment: llm.tool({
      description:
        "Find the earliest open appointment slot for a verified patient. Set earliestAfterDays to delay the window: 0 for an existing (already-verified) patient; for a NEW patient use the eligibility-verification turnaround — 5 days for managed care, 15 days for fee-for-service (default). Managed-care patients are matched to their assigned PCP's schedule.",
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
        const r = await medplum.bookAppointment(patientId, slotId);
        return { booked: true, start: r.start, appointmentId: r.appointmentId };
      },
    }),

    /** Managed-care guarantee: create an after-5pm overflow slot and book it. */
    create_priority_appointment: llm.tool({
      description:
        "Managed-care guarantee for a SICK managed-care patient when find_earliest_appointment found nothing acceptable: create an extra after-5pm slot on the patient's PCP schedule and book it. Use only in that case.",
      parameters: z.object({ patientId: z.string() }),
      execute: async ({ patientId }) => {
        const r = await medplum.createPrioritySlotAndBook(patientId);
        return r
          ? { booked: true, start: r.start, appointmentId: r.appointmentId }
          : { booked: false, message: "No assigned PCP/schedule to add an overflow slot to." };
      },
    }),
  };
}
