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
import * as livekit from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import dotenv from "dotenv";
import { AGENT_NAME, CareOpsAgent } from "./agent.ts";

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
      stt: new inference.STT({ model: "deepgram/nova-3", language: "multi" }),
      llm: new inference.LLM({ model: "openai/gpt-5.2-chat-latest" }),
      tts: new inference.TTS({
        model: "cartesia/sonic-3",
        voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
      }),
      turnHandling: { turnDetection: new livekit.turnDetector.MultilingualModel() },
    });

    await session.start({ agent: new CareOpsAgent(), room: ctx.room });
    await ctx.connect();
    await session.generateReply({
      instructions: "Greet the caller as CareOps Voice and ask for their full name and date of birth.",
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_AGENT_NAME ?? AGENT_NAME,
  }),
);
