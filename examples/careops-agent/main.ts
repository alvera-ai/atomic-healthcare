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
import { CareOpsAgent } from "./agent.ts";

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
    });

    await session.start({ agent: new CareOpsAgent(), room: ctx.room });
    await ctx.connect();
    await session.generateReply({
      instructions: "Greet the caller as CareOps Voice and ask for their full name and date of birth.",
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
