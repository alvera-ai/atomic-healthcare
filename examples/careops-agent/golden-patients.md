# CareOps Voice — golden patients

A fixed set of known callers — **golden patients** — for testing the agent over the
phone. Each is a real seeded patient (except the new-patient case, which is a name
that isn't seeded) with a script and the behavior the agent should produce. Dial each
into the LiveKit Console / Agents Playground (agent `atomic-healthcare-frontdesk`) or
by phone, speak the script, and check against the expectations. Together they cover
the whole loop: **identify → chart → book → log**.

> **Adding a golden patient:** pick a seeded patient, note their coverage + acuity
> (lookup snippet at the bottom), choose the branch to exercise (sick / routine /
> managed-care overflow / new), and write the expected tool trace + pass criteria.

```bash
LIVEKIT_AGENT_NAME=atomic-healthcare-frontdesk make run-careops-agent
```

**Watch the worker terminal** for the tool trace on each call:
`[resolve_patient] ← <name> NN%`, then `Executing LLM tool call function: "<tool>"`,
and on hangup `[call-summary] wrote Communication/<id>`.

**Verify writes** (easiest: open the patient in the provider app at
`localhost:3001` → timeline). Or via FHIR (needs a bearer token):
`Appointment?patient=Patient/<id>`, `Slot?schedule=Schedule/<id>`,
`Communication?subject=Patient/<id>`.

### Two seed caveats (set up before testing)
- **Slots span the next ~6 weeks** (`SCHEDULE_DAYS=30` weekdays, 9–12 & 2–5 in
  `scripts/seed.ts`) — enough headroom for the 15-day new-patient block-out and
  routine bookings.
- **Overflow (eval 1) only fires when the PCP has no free slot.** With seeded slots
  there's always one, so the setup step below clears the PCP's free slots first.

---

## Eval 1 — Managed-care, sick → create after-hours overflow slot

**Caller:** Carla Ariadna Ramón · DOB **1987-12-23** · phone **555-725-9618**
(Managed Care HMO, PCP **Dr. Ludivina Steuber**, patient `0293ae90-…`).

**Setup — force the overflow** (empty Dr. Steuber's free slots so none are bookable):
```bash
# marks every free Slot on Steuber's schedule busy; agent will have to create one
bun run - <<'TS'
import { MedplumClient } from "@medplum/core";
const m = new MedplumClient({ baseUrl: "http://localhost:8103/", fetch });
await m.startClientLogin(process.env.MEDPLUM_CLIENT_ID!, process.env.MEDPLUM_CLIENT_SECRET!);
const scheds = await m.searchResources("Schedule", { actor: "Practitioner/<STEUBER_ID>" });
for (const s of scheds) for (const slot of await m.searchResources("Slot", { schedule: `Schedule/${s.id}`, status: "free", _count: "500" }))
  await m.patchResource("Slot", slot.id!, [{ op: "replace", path: "/status", value: "busy" }]);
console.log("cleared Steuber free slots");
TS
```
(Get `<STEUBER_ID>` from the provider app or a Practitioner search.)

**Script:** *"Hi, this is Carla Ramón, December 23rd 1987. I've had bad chest tightness
since this morning and I need to be seen."* (give phone if it asks for a tie-breaker)

**Expected agent behavior**
1. `resolve_patient` → **≥0.90** (name+DOB, phone if needed) → "found your record".
2. `get_patient_chart` + `get_coverage` → coverage = **Managed Care**; caller states acute symptoms → judged **SICK**.
3. `find_earliest_appointment(patientId, 0)` → **no slot** (Steuber cleared).
4. `create_priority_appointment(patientId)` → creates an **after-5pm** Slot on Steuber's schedule and books it.
5. Tells Carla she's fit in after hours, with the date/time.
6. On hangup → `Communication` written to her chart.

**PASS if:** a new Slot exists at **17:00** on Steuber's schedule with status `busy`,
an `Appointment` (status booked) links Carla + Steuber to it, and a `Communication`
holds the transcript.

---

## Eval 2 — Normal existing patient → routine

**Caller:** Elsa Carlota Mena · DOB **1998-06-15** · phone **555-797-6470**
(Fee-for-Service, benign chart, patient `2b5c700a-…`).

**Setup:** none.

**Script:** *"Hi, Elsa Mena, June 15th 1998. Just calling to set up a check-up."*
(no acute symptoms — this is the routine path)

**Expected agent behavior**
1. `resolve_patient` → **≥0.90** → "found your record".
2. `get_patient_chart` + `get_coverage` → chart benign, **not acutely sick**.
3. Recommends a routine interval (generally healthy → **6–12 months**) with a short reason.
4. `find_earliest_appointment` for a near-term slot and `book_appointment` (or, if
   nothing falls in the recommended window given the ~2-week slot horizon, books the
   earliest available / states the recommendation).
5. On hangup → `Communication` written.

**PASS if:** the agent does **not** invoke the overflow path, gives a sensible
routine recommendation, books a real slot (or clearly states the next-visit window),
and logs the transcript.

---

## Eval 3 — New patient, FFS → register, then block out the verification window

**Caller:** a name **not** in the cohort, e.g. *"Marcus Webb, May 20th 1980,
555-018-2244"*, who says they have **Medicare** (fee-for-service).

**Setup:** none — slots span ~6 weeks, so +15 days has availability.

**Script:** *"Hi, my name's Marcus Webb, born May 20th 1980."* → (agent can't find
a record, asks for more, still no match) → agrees to register → gives phone →
when asked, *"I have Medicare."*

**Expected agent behavior**
1. `resolve_patient` → **no match** after a tie-breaker → treats as **NEW patient**.
2. `create_patient` → new Patient created in Medplum.
3. Asks insurance → Medicare = **fee-for-service** → block-out **≈15 days**.
4. `find_earliest_appointment(patientId, 15)` then `book_appointment`, explaining
   *"because we need to verify your new coverage first — about 15 days — the earliest
   we can see you is <date>."*
5. On hangup → `Communication` written to the **new** patient's chart.

**PASS if:** a new `Patient` exists, the offered appointment is **≥15 days out**
(or the agent correctly explains the 15-day verification wait if no slot exists that
far in the demo data), and the transcript `Communication` is on the new chart.

**Known gap:** the new patient is **not** in Watchman until a re-ingest, so a second
call won't resolve them yet (documented; deferred).

---

## Scorecard

| # | Scenario | Identity | Acuity branch | Booking action | Communication |
|---|----------|----------|---------------|----------------|---------------|
| 1 | Managed-care sick | ≥0.90 | SICK | **overflow** after-5pm slot | ✓ |
| 2 | Existing routine | ≥0.90 | not sick | routine slot / recommendation | ✓ |
| 3 | New FFS | no match → register | n/a (new) | book **≥15 days** out | ✓ (new chart) |

---

## Appendix — look up a patient to add as a golden patient

Lists each living patient with DOB, phone, coverage, PCP, and serious active
conditions (to pick the acuity branch you want):

```bash
bun run - <<'TS'
import { MedplumClient } from "@medplum/core";
const m = new MedplumClient({ baseUrl: "http://localhost:8103/", fetch });
await m.startClientLogin(process.env.MEDPLUM_CLIENT_ID!, process.env.MEDPLUM_CLIENT_SECRET!);
const serious = /cancer|kidney|diabet|heart|failure|copd|stroke|metabolic|hypertension|alzheimer/i;
for (const p of (await m.searchResources("Patient", { _count: "50" })) as any[]) {
  if (p.deceasedDateTime || p.deceasedBoolean) continue;
  const cov = (await m.searchResources("Coverage", { beneficiary: `Patient/${p.id}` }))[0] as any;
  const conds = (await m.searchResources("Condition", { patient: `Patient/${p.id}`, "clinical-status": "active", _count: "50" })) as any[];
  const sick = [...new Set(conds.map(c => c.code?.text ?? c.code?.coding?.[0]?.display).filter(Boolean))].filter(l => serious.test(l));
  const nm = p.name?.[0];
  console.log(`${nm?.given?.join(" ")} ${nm?.family} | DOB ${p.birthDate} | ${p.telecom?.find((t:any)=>t.system==="phone")?.value} | ${cov?.type?.text ?? "?"} | PCP ${p.generalPractitioner?.[0]?.display ?? "-"} | serious:${sick.length}`);
}
TS
```
