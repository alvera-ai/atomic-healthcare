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

const CONFIDENCE_GATE = 0.92;

export function careopsTools() {
  const medplum = new MedplumClient(settingsFromEnv());
  const moss = new MossClient(mossSettingsFromEnv());
  const watchman = new WatchmanClient(watchmanSettingsFromEnv());
  const loaded = new Set<string>(); // Moss indexes already pulled into memory this call

  return {
    /** Identity gate — Watchman fuzzy match, trusted only at ≥ 92%. */
    resolve_patient: llm.tool({
      description:
        "Identify the caller from their spoken name and date of birth (optionally phone or address as tie-breakers). " +
        "Returns the best match and a confidence between 0 and 1. Only trust a match when confidence is at least 0.92.",
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
            : "Below 0.92 confidence — ask for one more identifier (phone or address) and try again, or offer to register.",
        };
      },
    }),

    /** Pull facts from the verified patient's pre-seeded Moss chart index. */
    get_patient_chart: llm.tool({
      description:
        "Look up facts from a verified patient's chart (active conditions, recent labs, medications) to judge how sick they are. " +
        "Call only after resolve_patient confirms identity at ≥ 0.92.",
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
  };
}
