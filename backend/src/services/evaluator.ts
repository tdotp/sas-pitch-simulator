// Slow-lane evaluation: sends transcript + metrics + rubric to Claude Sonnet via
// OpenRouter and parses the structured JSON verdict. Never runs during the live
// conversation.
//
// Phase 4: explicit timeout (no request can hang indefinitely) + one bounded
// automatic retry for TRANSIENT failures only (timeout, 429, 5xx). A 4xx
// other than 429, or a JSON-parse failure, is NOT retried — retrying a bad
// request or a bad response shape won't fix it, it'll just cost another
// OpenRouter call. See RETRY_POLICY / TIMEOUT_POLICY in
// PHASE_04_SESSION_LIFECYCLE_REPORT.md.

import { config } from "../config.js";
import type { EvaluationResult, SpeechMetrics, TranscriptTurn } from "../types.js";
import type { ResolvedScenarioConfig } from "../engine-config/schema.js";
import {
  buildEvaluatorSystemPrompt,
  buildEvaluatorUserMessage,
} from "../engine/evaluatorPromptBuilder.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const EVALUATION_TIMEOUT_MS = 30_000;
const MAX_TRANSIENT_RETRIES = 1; // total attempts = 1 + this
const RETRY_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Safe, operational failure categories (PASS_WITH_FIXES round). These —
// never the raw OpenRouter response body/message — are what gets
// persisted as SessionRecord.failure_reason (see
// repositories/sessions.ts). The raw detail stays in EvaluationError's
// own `.message`, which routes.ts logs via console.error but never
// writes to Firestore or returns to the client.
export type EvaluationFailureCategory =
  | "OPENROUTER_TIMEOUT"
  | "OPENROUTER_NETWORK_ERROR"
  | "OPENROUTER_RATE_LIMITED"
  | "OPENROUTER_5XX"
  | "OPENROUTER_4XX"
  | "OPENROUTER_EMPTY_RESPONSE"
  | "OPENROUTER_INVALID_JSON"
  | "OPENROUTER_UNKNOWN_ERROR";

function categoryForStatus(status: number): EvaluationFailureCategory {
  if (status === 429) return "OPENROUTER_RATE_LIMITED";
  if (status >= 500) return "OPENROUTER_5XX";
  return "OPENROUTER_4XX";
}

// Pull the first balanced JSON object out of a model response, tolerating
// stray prose or code fences even though we asked for pure JSON.
function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) return s;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return s.slice(start);
}

// One HTTP attempt, timeout-bounded. Throws on any failure (network,
// timeout, non-2xx, empty content, bad JSON) — the caller decides what's
// retryable.
async function attemptEvaluation(
  systemPrompt: string,
  userMessage: string,
  scenarioId: string,
  sessionId: string
): Promise<EvaluationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVALUATION_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.openrouter.siteUrl,
        "X-Title": config.openrouter.appName,
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new EvaluationError(
        `OpenRouter evaluation timed out after ${EVALUATION_TIMEOUT_MS}ms`,
        true,
        "OPENROUTER_TIMEOUT"
      );
    }
    throw new EvaluationError(
      `OpenRouter request failed: ${(err as Error).message}`,
      true,
      "OPENROUTER_NETWORK_ERROR"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The raw response body can be arbitrary upstream text — it goes into
    // .message (routes.ts logs it, never persists or returns it), never
    // into the category.
    const body = await res.text();
    throw new EvaluationError(
      `OpenRouter evaluation failed (${res.status}): ${body.slice(0, 400)}`,
      isTransientStatus(res.status),
      categoryForStatus(res.status)
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new EvaluationError("OpenRouter returned empty content", false, "OPENROUTER_EMPTY_RESPONSE");
  }

  let parsed: EvaluationResult;
  try {
    parsed = JSON.parse(extractJson(content)) as EvaluationResult;
  } catch (err) {
    throw new EvaluationError(
      `No se pudo parsear el JSON del evaluador: ${(err as Error).message}`,
      false, // not transient — retrying won't change how the model formats it
      "OPENROUTER_INVALID_JSON"
    );
  }

  parsed.session_id = sessionId;
  parsed.target_mode = scenarioId; // deprecated wire-compat mirror, see types.ts
  return parsed;
}

// Distinguishes transient (worth one bounded retry) from non-transient
// failures, and carries a safe category for persistence — without
// leaking the raw message past where it's meant to be logged. Exported
// so routes.ts can read `.category` without needing to know about
// EvaluationError's internals otherwise.
export class EvaluationError extends Error {
  transient: boolean;
  category: EvaluationFailureCategory;
  constructor(message: string, transient: boolean, category: EvaluationFailureCategory) {
    super(message);
    this.name = "EvaluationError";
    this.transient = transient;
    this.category = category;
  }
}

// Phase 5: no `target: TargetMode` — the evaluator consumes an already-
// RESOLVED scenario config (interviewer/evaluationFramework/content all
// looked up and cross-referenced by the caller). This function never
// imports a fixed rubric and never branches on which client/scenario
// it's evaluating.
export async function evaluatePitch(params: {
  sessionId: string;
  resolved: ResolvedScenarioConfig;
  transcript: TranscriptTurn[];
  durationSeconds: number;
  metrics: SpeechMetrics;
}): Promise<EvaluationResult> {
  const systemPrompt = buildEvaluatorSystemPrompt(params.resolved);
  const userMessage = buildEvaluatorUserMessage({
    sessionId: params.sessionId,
    resolved: params.resolved,
    transcript: params.transcript,
    durationSeconds: params.durationSeconds,
    metrics: params.metrics,
  });

  let lastError: EvaluationError | null = null;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await attemptEvaluation(systemPrompt, userMessage, params.resolved.scenario.id, params.sessionId);
    } catch (err) {
      const evalErr =
        err instanceof EvaluationError
          ? err
          : new EvaluationError((err as Error).message, false, "OPENROUTER_UNKNOWN_ERROR");
      lastError = evalErr;
      if (evalErr.transient && attempt < MAX_TRANSIENT_RETRIES) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      throw evalErr;
    }
  }
  // Unreachable (the loop always returns or throws), but keeps TS happy.
  throw lastError ?? new Error("OpenRouter evaluation failed");
}
