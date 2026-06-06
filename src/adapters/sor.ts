/**
 * SoRAdapter — the System-of-Record contract.
 *
 * This is the boundary's view of "the record system." Verbs depend ONLY on this
 * interface, never on a concrete backend. Medplum is the first implementation
 * (see ./medplum); Epic / Athena / any FHIR-ish record system slot in behind the
 * same interface without touching the verb layer.
 *
 * Keep this interface record-agnostic: no Medplum types leak through. Inputs and
 * outputs are plain, typed shapes the verb layer can reason about.
 */

export type PatientMatch = {
  id: string;
  name: string;
  birthDate?: string;
  gender?: string;
};

export type CoverageSummary = {
  active: boolean;
  payor?: string;
  planType?: string;
  raw?: unknown;
};

export type Slot = {
  id: string;
  start: string;
  end: string;
  scheduleId: string;
};

export type BookedAppointment = {
  id: string;
  start: string;
  end: string;
  patientId: string;
};

export type EscalationResult = {
  taskId: string;
  communicationId?: string;
  priority: "routine" | "urgent" | "stat";
};

export type FindSlotsInput = {
  scheduleId: string;
  start: string;
  end: string;
  count?: number;
};

export type BookInput = {
  patientId: string;
  slot: Slot;
  reasonCode?: string;
  description?: string;
};

export type EscalateInput = {
  patientId: string;
  title: string;
  description: string;
  priority?: "routine" | "urgent" | "stat";
};

/**
 * The contract every system-of-record adapter must satisfy.
 *
 * `kind` identifies the backend (e.g. "medplum") for audit + control-pane labels.
 */
export interface SoRAdapter {
  readonly kind: string;

  /** Liveness/auth check. Returns true if the adapter can reach the record system. */
  ping(): Promise<boolean>;

  // ── reads (auto, ungated) ───────────────────────────────────────────────
  verifyPatient(name: string, birthDate: string): Promise<PatientMatch | null>;
  getCoverage(patientId: string): Promise<CoverageSummary | null>;
  findSlots(input: FindSlotsInput): Promise<Slot[]>;

  // ── writes (gated — go through the policy gate before this is called) ────
  book(input: BookInput): Promise<BookedAppointment>;
  escalate(input: EscalateInput): Promise<EscalationResult>;
}
