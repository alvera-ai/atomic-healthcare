# AGENTS.md — build conventions for Atomic Healthcare

Instructions for any AI coding agent (Claude Code, Cursor, Codex) or human
working **on** this repository. Read this before writing code.

---

## The one architectural law

> **The agent supplies WHAT. The boundary holds WHERE. They never mix.**

- **WHAT** — a verb name + typed args. Git-shareable. No secrets, ever.
- **WHERE** — credentials + base URLs, in a per-machine profile under `~/.atomic/`.
  Gitignored. Written once by `configure`. Read only by the verb library.

Any code that puts a credential into agent-facing code, a log line, CLI output,
or a committed file is a **bug**, not a style nit. Redact on output. Always.

---

## Layering — never skip a layer

```
   voice agent  ─┐
   cli.ts       ─┼─▶  VERB LIBRARY  ─▶  SoR ADAPTER  ─▶  system of record
   control pane ─┘    (boundary,        (interface,       (Medplum today;
                       audit, gate)      Medplum impl)     Epic/Athena later)
```

1. **Entry points** (`cli.ts`, `voice/`, `control-pane/`) are thin. They parse
   input and call verb functions. They contain **no** SoR logic and **no** creds.
2. **Verb library** (`src/verbs/`) is the only place that loads the profile,
   writes the audit log, and enforces the policy gate. This is the credential
   boundary.
3. **SoR adapter** (`src/adapters/`) is a pluggable interface. Verbs talk to
   `SoRAdapter`, never to `@medplum/core` directly. Swapping Medplum for another
   record system must touch **only** `src/adapters/`.

If you find yourself importing `@medplum/core` outside `src/adapters/medplum/`,
stop — you're leaking the SoR into a layer that should be record-agnostic.

---

## Rules

1. **Adapters are interface-first.** Define `SoRAdapter` (the contract), then
   implement `MedplumAdapter`. Verbs depend on the interface, not the impl.
2. **Every verb is auditable.** A verb that mutates the SoR MUST emit an audit
   entry (`who / what / args / result / timestamp`) and MUST be replayable.
3. **Write verbs pass through the gate.** `book`, `escalate`, `call-patient` and
   any other mutation are gated: the control pane can require human approval
   before they execute. Reads (`verify-patient`, `get-context`) run auto.
4. **No secrets in output.** CLI output, `--debug` logs, and audit entries redact
   tokens/keys. The profile is the only place a raw secret lives.
5. **Typed FHIR.** Use `@medplum/fhirtypes` inside the Medplum adapter so resource
   shapes are checked at build time. Don't hand-build loose FHIR objects.
6. **In-process, not subprocess.** The voice agent imports verb functions
   directly — never shells out to the CLI per call (cold-start kills live voice).
7. **Deterministic SoR, fuzzy knowledge.** Medplum returns ground truth (records).
   Moss (bonus) returns retrieval/citations. Never let an LLM be the final
   authority on a record write — a verb + the SoR decides; the LLM only proposes.
8. **Bun-native.** Use Bun APIs (`Bun.file`, `Bun.spawn`, `bun:test`). Compile the
   CLI with `bun build --compile` when distributing a binary.

---

## Repo map

```
   src/
     adapters/
       sor.ts              ★ SoRAdapter interface — the contract
       medplum/            Medplum implementation (wraps @medplum/core)
     verbs/
       profile.ts          load ~/.atomic/<profile>.toml
       audit.ts            append-only verb log
       gate.ts             which verbs need human approval
       patient.ts          verify-patient, get-context, find-slots
       booking.ts          book, escalate          (gated)
       contracts.ts        get-contract-context, check-denial   (bonus, Moss)
     cli.ts                terminal entry → verbs
     control-pane/         live feed + approve/deny (human overlord)
     voice/                LiveKit agent → tools wrap verbs
     seed/                 synthea.ts, contracts.ts
   infra/
     docker-compose.yml    local Medplum
```

---

## Definition of done (per verb)

A verb is done when:

- it implements against `SoRAdapter`, not a concrete SoR;
- it emits an audit entry;
- if it mutates, it passes through `gate.ts`;
- it is reachable from **both** `cli.ts` and a voice tool;
- output redacts secrets;
- there's a `bun:test` covering the happy path with a fake adapter.

---

## Commands

```bash
bun install
bun run medplum:up        # start local Medplum (system of record)
bun run cli <verb> ...    # drive a verb from the terminal
bun test                  # run the suite
```
