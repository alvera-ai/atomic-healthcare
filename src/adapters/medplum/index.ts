/**
 * MedplumAdapter — the first SoRAdapter implementation.
 *
 * Wraps @medplum/core. This is the ONLY file in the repo allowed to import
 * Medplum or FHIR types — everything above it speaks the record-agnostic
 * SoRAdapter contract. Swapping Medplum for Epic/Athena means writing a sibling
 * adapter, not changing a single verb.
 *
 * Auth modes (resolved from the profile, never from agent-facing code):
 *   - password           local Medplum admin (email + password)
 *   - clientCredentials  ClientApplication (clientId + clientSecret) — API-key style
 *   - token              static access token
 */

import { MedplumClient } from "@medplum/core";
import type {
  Appointment,
  Communication,
  Coverage,
  Patient,
  Slot as FhirSlot,
  Task,
} from "@medplum/fhirtypes";
import type {
  BookedAppointment,
  BookInput,
  CoverageSummary,
  EscalateInput,
  EscalationResult,
  FindSlotsInput,
  PatientMatch,
  Slot,
  SoRAdapter,
} from "../sor.ts";

export type MedplumAuth =
  | { mode: "password"; email: string; password: string }
  | { mode: "clientCredentials"; clientId: string; clientSecret: string }
  | { mode: "token"; accessToken: string };

export type MedplumAdapterConfig = {
  baseUrl: string;
  auth: MedplumAuth;
};

function patientDisplayName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) return "Unknown";
  if (name.text) return name.text;
  return [name.given?.join(" "), name.family].filter(Boolean).join(" ").trim() || "Unknown";
}

export class MedplumAdapter implements SoRAdapter {
  readonly kind = "medplum";
  private readonly client: MedplumClient;
  private readonly auth: MedplumAuth;
  private authed = false;

  constructor(config: MedplumAdapterConfig) {
    this.client = new MedplumClient({ baseUrl: config.baseUrl, fetch });
    this.auth = config.auth;
  }

  /** Authenticate once, lazily. Subsequent calls are no-ops. */
  private async ensureAuth(): Promise<void> {
    if (this.authed) return;
    switch (this.auth.mode) {
      case "password": {
        const login = await this.client.startLogin({
          email: this.auth.email,
          password: this.auth.password,
        });
        if (!login.code) {
          throw new Error("Medplum login did not return an authorization code.");
        }
        await this.client.processCode(login.code);
        break;
      }
      case "clientCredentials":
        await this.client.startClientLogin(this.auth.clientId, this.auth.clientSecret);
        break;
      case "token":
        this.client.setAccessToken(this.auth.accessToken);
        break;
    }
    this.authed = true;
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureAuth();
      await this.client.search("Patient", { _count: "1" });
      return true;
    } catch {
      return false;
    }
  }

  async verifyPatient(name: string, birthDate: string): Promise<PatientMatch | null> {
    await this.ensureAuth();
    const results = await this.client.searchResources("Patient", {
      name,
      birthdate: birthDate,
    });
    const patient = results[0];
    if (!patient?.id) return null;
    return {
      id: patient.id,
      name: patientDisplayName(patient),
      birthDate: patient.birthDate,
      gender: patient.gender,
    };
  }

  async getCoverage(patientId: string): Promise<CoverageSummary | null> {
    await this.ensureAuth();
    const results = await this.client.searchResources("Coverage", {
      beneficiary: `Patient/${patientId}`,
      status: "active",
    });
    const coverage = results[0] as Coverage | undefined;
    if (!coverage) return null;
    return {
      active: coverage.status === "active",
      payor: coverage.payor?.[0]?.display,
      planType: coverage.type?.text,
      raw: coverage,
    };
  }

  async findSlots(input: FindSlotsInput): Promise<Slot[]> {
    await this.ensureAuth();
    const results = await this.client.searchResources("Slot", {
      schedule: `Schedule/${input.scheduleId}`,
      status: "free",
      start: `ge${input.start}`,
      _count: String(input.count ?? 5),
    });
    return (results as FhirSlot[])
      .filter((slot): slot is FhirSlot & { id: string; start: string; end: string } =>
        Boolean(slot.id && slot.start && slot.end),
      )
      .map((slot) => ({
        id: slot.id,
        start: slot.start,
        end: slot.end,
        scheduleId: input.scheduleId,
      }));
  }

  async book(input: BookInput): Promise<BookedAppointment> {
    await this.ensureAuth();
    // Atomic single-resource create — no GET-then-PATCH race.
    const appointment = (await this.client.createResource({
      resourceType: "Appointment",
      status: "booked",
      description: input.description ?? "Atomic Healthcare booking",
      start: input.slot.start,
      end: input.slot.end,
      ...(input.reasonCode
        ? { reasonCode: [{ text: input.reasonCode }] }
        : {}),
      slot: [{ reference: `Slot/${input.slot.id}` }],
      participant: [
        {
          actor: { reference: `Patient/${input.patientId}` },
          status: "accepted",
        },
      ],
    } satisfies Appointment)) as Appointment;

    if (!appointment.id) throw new Error("Medplum did not return an appointment id.");
    return {
      id: appointment.id,
      start: appointment.start ?? input.slot.start,
      end: appointment.end ?? input.slot.end,
      patientId: input.patientId,
    };
  }

  async escalate(input: EscalateInput): Promise<EscalationResult> {
    await this.ensureAuth();
    const priority = input.priority ?? "urgent";

    const task = (await this.client.createResource({
      resourceType: "Task",
      status: "requested",
      intent: "order",
      priority: priority === "urgent" ? "asap" : priority === "stat" ? "stat" : "routine",
      for: { reference: `Patient/${input.patientId}` },
      description: input.description,
      code: { text: input.title },
    } satisfies Task)) as Task;

    const communication = (await this.client.createResource({
      resourceType: "Communication",
      status: "completed",
      subject: { reference: `Patient/${input.patientId}` },
      payload: [{ contentString: `${input.title}: ${input.description}` }],
    } satisfies Communication)) as Communication;

    if (!task.id) throw new Error("Medplum did not return a task id.");
    return {
      taskId: task.id,
      communicationId: communication.id,
      priority,
    };
  }
}

export function createMedplumAdapter(config: MedplumAdapterConfig): MedplumAdapter {
  return new MedplumAdapter(config);
}
