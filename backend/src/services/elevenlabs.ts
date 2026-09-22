// ElevenLabs Conversational AI integration. The backend mints a signed URL
// (keeping the API key server-side) and computes the per-scenario agent
// overrides (system prompt, first message, voice) that the frontend SDK applies
// at startSession. This is the "fast lane": STT + turn-taking + TTS handled
// natively by ElevenLabs for lowest latency.

import { config } from "../config.js";
import type { TargetMode, VoiceGender } from "../types.js";
import { buildInterviewerPrompt } from "../data/prompts.js";

const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

// Phase 4: small, coherent addition alongside the OpenRouter timeout in
// services/evaluator.ts — no request to an external provider should be
// able to hang indefinitely. No retry here (unlike the evaluator): a
// failed getSignedUrl already surfaces as a clean 502 from /session/start
// (see routes.ts), and simply retrying the whole /session/start call is
// already cheap and safe — no separate retry policy needed for this call.
const SIGNED_URL_TIMEOUT_MS = 10_000;

export interface AgentOverrides {
  agent: {
    prompt: { prompt: string };
    first_message: string;
    language: string;
  };
  tts: { voice_id: string };
}

export interface SignedUrlResult {
  signed_url: string;
  agent_id: string;
  voice_id: string;
  voice_gender: VoiceGender;
  overrides: AgentOverrides;
}

// Pick a concrete voice id for the scenario + requested gender.
export function resolveVoice(
  target: TargetMode,
  requested?: VoiceGender
): { voiceId: string; gender: VoiceGender } {
  const v = config.elevenlabs.voices;

  // Davivienda → male, Grupo Aval → female (per brief). Generic → requested.
  if (target === "davivienda") return { voiceId: v.male, gender: "male" };
  if (target === "grupo_aval") return { voiceId: v.female, gender: "female" };

  // generic
  const gender = requested ?? "random";
  if (gender === "male") return { voiceId: v.male, gender: "male" };
  if (gender === "female") return { voiceId: v.female, gender: "female" };

  // random: choose among the configured pool, fallback to male/female.
  const pool = [v.genericA, v.genericB, v.male, v.female].filter(Boolean);
  const chosen = pool.length
    ? pool[Math.floor(Math.random() * pool.length)]
    : v.male;
  const gender2: VoiceGender = chosen === v.female ? "female" : "male";
  return { voiceId: chosen, gender: gender2 };
}

export function buildOverrides(
  target: TargetMode,
  voiceId: string
): AgentOverrides {
  const { systemPrompt, firstMessage } = buildInterviewerPrompt(target);
  return {
    agent: {
      prompt: { prompt: systemPrompt },
      first_message: firstMessage,
      language: "es",
    },
    tts: { voice_id: voiceId },
  };
}

export async function getSignedUrl(
  target: TargetMode,
  requestedVoice?: VoiceGender
): Promise<SignedUrlResult> {
  const agentId = config.elevenlabs.agentId;
  const { voiceId, gender } = resolveVoice(target, requestedVoice);

  const url = `${ELEVEN_BASE}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
    agentId
  )}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGNED_URL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "xi-api-key": config.elevenlabs.apiKey },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`ElevenLabs signed-url request timed out after ${SIGNED_URL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `ElevenLabs signed-url failed (${res.status}): ${body.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as { signed_url: string };

  return {
    signed_url: data.signed_url,
    agent_id: agentId,
    voice_id: voiceId,
    voice_gender: gender,
    overrides: buildOverrides(target, voiceId),
  };
}
