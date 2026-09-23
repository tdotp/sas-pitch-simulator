// ElevenLabs Conversational AI integration. The backend mints a signed URL
// (keeping the API key server-side) and computes the per-scenario agent
// overrides (system prompt, first message, voice) that the frontend SDK applies
// at startSession. This is the "fast lane": STT + turn-taking + TTS handled
// natively by ElevenLabs for lowest latency.
//
// Phase 5: takes a ResolvedScenarioConfig, not a TargetMode. No branching
// on client/scenario identity lives here — voice selection reads
// InterviewerProfile.voice.slot (a generic "male"/"female"/"random" slot,
// config), never a scenario id.

import { z } from "zod";
import { config } from "../config.js";
import type { VoiceGender } from "../types.js";
import type { ResolvedScenarioConfig } from "../engine-config/schema.js";
import { buildInterviewerPrompt } from "../engine/promptBuilder.js";
import { logEvent, elapsedMs } from "../observability/log.js";

// Fase 7: safe, stable, non-sensitive failure categories — mirrors
// EvaluationFailureCategory's shape in services/evaluator.ts. Never the
// raw response body/message (which can carry upstream detail): those stay
// in ElevenLabsError's own `.message`, logged but never persisted.
export type ElevenLabsFailureCategory =
  | "ELEVENLABS_TIMEOUT"
  | "ELEVENLABS_NETWORK_ERROR"
  | "ELEVENLABS_RATE_LIMITED"
  | "ELEVENLABS_4XX"
  | "ELEVENLABS_5XX"
  | "ELEVENLABS_INVALID_RESPONSE";

export class ElevenLabsError extends Error {
  category: ElevenLabsFailureCategory;
  constructor(message: string, category: ElevenLabsFailureCategory) {
    super(message);
    this.name = "ElevenLabsError";
    this.category = category;
  }
}

function categoryForStatus(status: number): ElevenLabsFailureCategory {
  if (status === 429) return "ELEVENLABS_RATE_LIMITED";
  if (status >= 500) return "ELEVENLABS_5XX";
  return "ELEVENLABS_4XX";
}

// Runtime validation of the get-signed-url response body: a 200 with an
// unexpected/empty body (e.g. `{}`, an HTML error page) is NOT a success —
// see ELEVENLABS_INVALID_RESPONSE below.
const SignedUrlResponseSchema = z.object({
  signed_url: z.string().min(1),
});

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

// Resolves a symbolic voice slot (config: InterviewerProfile.voice.slot,
// optionally overridden per-request by the caller for the "random" case)
// to a concrete ElevenLabs voice id. The actual ids stay in env config
// (config.elevenlabs.voices) — never in a content package — so a config
// package can ship to Firestore later without carrying provider secrets.
function resolveVoice(
  slot: "male" | "female" | "random",
  requestedOverride?: VoiceGender
): { voiceId: string; gender: VoiceGender } {
  const v = config.elevenlabs.voices;
  const effective = requestedOverride ?? slot;

  if (effective === "male") return { voiceId: v.male, gender: "male" };
  if (effective === "female") return { voiceId: v.female, gender: "female" };

  // random: choose among the configured pool, fallback to male/female.
  const pool = [v.genericA, v.genericB, v.male, v.female].filter(Boolean);
  const chosen = pool.length ? pool[Math.floor(Math.random() * pool.length)] : v.male;
  const gender: VoiceGender = chosen === v.female ? "female" : "male";
  return { voiceId: chosen, gender };
}

export function buildOverrides(resolved: ResolvedScenarioConfig, voiceId: string): AgentOverrides {
  const { systemPrompt, firstMessage } = buildInterviewerPrompt(resolved);
  return {
    agent: {
      prompt: { prompt: systemPrompt },
      first_message: firstMessage,
      language: resolved.client.defaultLanguage,
    },
    tts: { voice_id: voiceId },
  };
}

export async function getSignedUrl(
  resolved: ResolvedScenarioConfig,
  requestedVoice?: VoiceGender
): Promise<SignedUrlResult> {
  const agentId = config.elevenlabs.agentId;
  const { voiceId, gender } = resolveVoice(resolved.interviewerProfile.voice.slot, requestedVoice);

  const url = `${ELEVEN_BASE}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
    agentId
  )}`;

  const start = Date.now();
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
    const elevenErr =
      err instanceof Error && err.name === "AbortError"
        ? new ElevenLabsError(
            `ElevenLabs signed-url request timed out after ${SIGNED_URL_TIMEOUT_MS}ms`,
            "ELEVENLABS_TIMEOUT" as const
          )
        : new ElevenLabsError(
            `ElevenLabs signed-url request failed: ${(err as Error).message}`,
            "ELEVENLABS_NETWORK_ERROR" as const
          );
    logSignedUrlOutcome(start, "failure", elevenErr.category);
    throw elevenErr;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Raw upstream body stays in `.message` (logged, never persisted or
    // returned to the client) — never in `.category`.
    const body = await res.text();
    const category = categoryForStatus(res.status);
    logSignedUrlOutcome(start, "failure", category);
    throw new ElevenLabsError(`ElevenLabs signed-url failed (${res.status}): ${body.slice(0, 300)}`, category);
  }

  // Fase 7: a 200 is not automatically a success — the body must actually
  // contain a usable signed_url. PASS_WITH_FIXES P1.1: res.json() itself
  // throws (SyntaxError) for a 2xx whose body isn't valid JSON at all
  // (an HTML error page, truncated JSON) — that must be caught here and
  // classified the same as a schema failure, never left to propagate as
  // an unclassified error. The raw body is deliberately never read/kept
  // in this branch (no `.text()` fallback for the message) — it's not
  // needed and the instruction is explicit: never put it in the public
  // error.
  let rawBody: unknown;
  try {
    rawBody = await res.json();
  } catch {
    logSignedUrlOutcome(start, "failure", "ELEVENLABS_INVALID_RESPONSE");
    throw new ElevenLabsError(
      "ElevenLabs signed-url response was not valid JSON",
      "ELEVENLABS_INVALID_RESPONSE"
    );
  }
  const parsed = SignedUrlResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    logSignedUrlOutcome(start, "failure", "ELEVENLABS_INVALID_RESPONSE");
    throw new ElevenLabsError(
      `ElevenLabs signed-url response failed validation: ${parsed.error.message}`,
      "ELEVENLABS_INVALID_RESPONSE"
    );
  }

  logSignedUrlOutcome(start, "success");

  return {
    signed_url: parsed.data.signed_url,
    agent_id: agentId,
    voice_id: voiceId,
    voice_gender: gender,
    overrides: buildOverrides(resolved, voiceId),
  };
}

// Fase 7: LATENCY_MEASUREMENT + STRUCTURED_LOGGING. Deliberately never
// takes the signed_url or the request/response body — only timing,
// outcome and a safe category, see LogFields in observability/log.ts.
function logSignedUrlOutcome(
  startMs: number,
  outcome: "success" | "failure",
  error_category?: ElevenLabsFailureCategory
): void {
  logEvent({
    event: "elevenlabs_signed_url",
    provider: "elevenlabs",
    duration_ms: elapsedMs(startMs),
    outcome,
    ...(error_category ? { error_category } : {}),
  });
}
