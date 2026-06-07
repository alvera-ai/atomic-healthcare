/**
 * main.ts — LiveKit Agents worker entrypoint.
 *
 *   bun run examples/careops-agent/main.ts download-files   # one-time: VAD/turn model
 *   bun run examples/careops-agent/main.ts dev              # run the worker
 *
 * STT/LLM/TTS go through LiveKit Inference (no separate provider keys — just the
 * LIVEKIT_* credentials). Silero supplies VAD; the LiveKit plugin supplies turn
 * detection.
 */

import { fileURLToPath } from "node:url";
import {
  cli,
  defineAgent,
  inference,
  type JobContext,
  type JobProcess,
  ServerOptions,
  voice,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import dotenv from "dotenv";
import { MedplumClient, settingsFromEnv } from "../../src/medplum.ts";
import { CareOpsAgent } from "./agent.ts";
import type { CallState } from "./tools.ts";

dotenv.config();

type ProcessUserData = { vad?: silero.VAD };

export default defineAgent<ProcessUserData>({
  prewarm: async (proc: JobProcess<ProcessUserData>) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext<ProcessUserData>) => {
    const vad = ctx.proc.userData.vad;
    if (!vad) throw new Error("Silero VAD did not load during prewarm.");

    const session = new voice.AgentSession({
      vad,
      // English STT — the EOU model is English-only ("multi" logged warnings and hurt
      // digit recognition). gpt-4.1 supports tools (the "*-chat-latest" variants do
      // NOT — with tools attached they hang). No heavy turn-detector model: on a
      // resource-constrained machine its ONNX inference runs slower than realtime and
      // makes the call choppy/"stuck"; Silero VAD handles turns and is far lighter.
      stt: new inference.STT({ model: "deepgram/nova-3", language: "en" }),
      llm: new inference.LLM({ model: "openai/gpt-4.1" }),
      tts: new inference.TTS({
        model: "cartesia/sonic-3",
        voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
      }),
      // Require ≥2 actually-transcribed words to interrupt the agent. Phone echo /
      // background noise produces VAD blips but no real words, so this stops the
      // "resumed false interrupted speech" cut-offs that made replies inaudible.
      // turnDetection is left unset → the session auto-selects VAD (lightweight).
      //
      // preemptiveGeneration OFF: it starts the LLM reply BEFORE the caller's turn
      // ends, so when the caller keeps talking (e.g. "that's correct, you got it
      // right") the in-flight reply is aborted mid-tool-call — LiveKit then drops the
      // tool's output ("function call missing the corresponding function output") and
      // the LLM re-issues the SAME tool, looping until the call hangs. Generating only
      // after the turn truly ends lets resolve_patient / booking calls complete cleanly.
      turnHandling: {
        interruption: { minWords: 2 },
        preemptiveGeneration: { enabled: false },
      },
    });

    // Shared per-call state: tools record the resolved patientId here so we can write
    // the transcript to the right chart when the call ends.
    const callState: CallState = {};

    // When the call ends (hangup/shutdown), write the full transcript to the patient's
    // chart as a FHIR Communication.
    ctx.addShutdownCallback(async () => {
      try {
        const itemCount = session.history.items.length;
        console.error(`[call-summary] shutdown: patientId=${callState.patientId ?? "none"} historyItems=${itemCount}`);
        if (!callState.patientId) return;
        const lines = session.history.items
          .map((it) => it as { role?: string; textContent?: string })
          .filter((it) => it.role === "user" || it.role === "assistant")
          .map((it) => `${it.role === "user" ? "Caller" : "Agent"}: ${(it.textContent ?? "").trim()}`)
          .filter((l) => !l.endsWith(":"));
        if (lines.length === 0) {
          console.error("[call-summary] no transcribed turns — nothing to write");
          return;
        }
        const transcript = `CareOps Voice call — ${new Date().toISOString()}\n\n${lines.join("\n")}`;
        const medplum = new MedplumClient(settingsFromEnv());
        // Bound the write so a slow/hung network call can't make the job unresponsive
        // (LiveKit force-SIGTERMs an unresponsive job and the Communication is lost).
        const id = await Promise.race([
          medplum.logCallSummary(callState.patientId, transcript),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("logCallSummary timed out after 10s")), 10_000)),
        ]);
        console.error(`[call-summary] wrote Communication/${id} for Patient/${callState.patientId}`);
      } catch (err) {
        console.error(`[call-summary] failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    await session.start({ agent: new CareOpsAgent(callState), room: ctx.room });
    await ctx.connect();
    await session.generateReply({
      instructions:
        "Warmly welcome the caller to CareOps Voice. In one short sentence, explain that to protect their privacy you need to verify their identity before pulling up their record. Then ask for their full name to begin.",
    });
  },
});

// Stable agent name so the Playground's dispatch always routes to THIS worker
// (override with LIVEKIT_AGENT_NAME). Keep exactly one worker running for this name.
const agentName = process.env.LIVEKIT_AGENT_NAME ?? "careops-inbound";
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName,
  }),
);
