# Atomic Healthcare

> An open-source **control plane for agentic healthcare**. A voice agent does real
> clinical operations — verify a patient, check coverage, book, escalate, call a
> patient back — but it **never holds a credential** and **never acts unseen**.
> Every action is a typed verb routed through a safe boundary into a system of
> record, logged, attributable, and replayable. Risky actions pause for a **human
> overlord** who watches a live feed and approves or denies.

It is the safety layer that makes AI agents on protected health information (PHI)
deployable: **security, human control, and an audit trail** — without rebuilding
the legacy EHR.

## Why this exists

Three real, named problems in healthcare:

- **Information blocking** (21st Century Cures Act / ONC) — data is locked away.
- **Non-API legacy systems** — Epic, Athena, and friends don't expose clean APIs.
- **Agent oversight** — nobody will let an AI act on a patient record unsupervised.

Atomic Healthcare answers all three with one idea: **the agent never touches a
credential and never acts unseen.** It calls *verbs*; a credential-holding
boundary executes them against the system of record and shows a human everything.

## The three pieces

```
   Caller ──voice──▶ LiveKit agent
                          │ imports the VERB LIBRARY (in-process, no creds)
                          │ every verb → audit log + policy gate
            ┌─────────────┼──────────────────┐
            ▼             ▼                  ▼
       knowledge      SYSTEM OF RECORD   CONTROL PANE
       (Moss, bonus)  (Medplum adapter)  (human overlord:
                       deterministic      live feed + approve/deny)
```

1. **Verb library** — the credential boundary. Holds the secrets, reads a profile
   written once by `configure`, exposes typed verbs. The agent imports it; the CLI
   imports it. Neither the agent nor a human caller ever sees a token.
2. **System-of-record adapter** — a pluggable interface. **Medplum** is the first
   adapter (works locally via Docker, deterministic FHIR). Others (Epic, Athena)
   slot in behind the same interface.
3. **Control pane** — the human overlord. A live feed of every verb the agent
   invokes; write-class actions (`book`, `escalate`, `call-patient`) pause for
   explicit human approve / deny.

## Architecture in one rule

> **WHAT** the agent wants (a verb + args) is separate from **WHERE** the
> credentials live (a per-machine profile). The agent supplies the first and
> never sees the second. Every action crosses the boundary and lands in the
> audit log.

## System of record: Medplum (the demo adapter)

Medplum is used as the demo system of record because it runs fully locally:

```
   Server:    http://localhost:8103
   Admin UI:  http://localhost:3005
   Login:     admin@example.com / medplum_admin   (Medplum default seed)
```

The Medplum adapter wraps `@medplum/core` — typed FHIR, auth handled. It is an
**adapter**, not the core: the verb library talks to an `SoRAdapter` interface,
and Medplum is one implementation.

## Quick start

```bash
bun install

# 1. start the system of record (local Medplum)
bun run medplum:up

# 2. point a profile at it (writes ~/.atomic/<profile>.toml — gitignored)
bun run cli configure

# 3. seed a clean demo cohort (Synthea, human names, scheduling scaffold)
bun run cli seed-patients

# 4. drive verbs from the terminal
bun run cli verify-patient --name "Dorothy Harmon" --dob 1948-07-22
```

The voice agent and control pane import the same verb library — see
[`AGENTS.md`](./AGENTS.md) for the build conventions.

## Status

| Layer | State |
|------|-------|
| Medplum adapter (`@medplum/core`) | scaffolding |
| Verb library + profile + audit | scaffolding |
| Control pane (human overlord) | planned |
| LiveKit voice (in + outbound) | planned |
| Moss + Unsiloed (contract knowledge) | bonus |

## License

[MIT](./LICENSE).
