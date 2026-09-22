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
import type {
  EvaluationResult,
  SpeechMetrics,
  TargetMode,
  TranscriptTurn,
} from "../types.js";
import {
  EVALUATOR_SYSTEM_PROMPT,
  buildEvaluatorUserMessage,
} from "../data/evaluatorPrompt.js";

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
  userMessage: string,
  target: TargetMode,
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
          { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new EvaluationError(
        `OpenRouter evaluation timed out after ${EVALUATION_TIMEOUT_MS}ms`,
        true
      );
    }
    throw new EvaluationError(`OpenRouter request failed: ${(err as Error).message}`, true);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new EvaluationError(
      `OpenRouter evaluation failed (${res.status}): ${body.slice(0, 400)}`,
      isTransientStatus(res.status)
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new EvaluationError("OpenRouter returned empty content", false);
  }

  let parsed: EvaluationResult;
  try {
    parsed = JSON.parse(extractJson(content)) as EvaluationResult;
  } catch (err) {
    throw new EvaluationError(
      `No se pudo parsear el JSON del evaluador: ${(err as Error).message}`,
      false // not transient — retrying won't change how the model formats it
    );
  }

  parsed.session_id = sessionId;
  parsed.target_mode = target;
  return parsed;
}

// Distinguishes transient (worth one bounded retry) from non-transient
// failures, without leaking that distinction past this module.
class EvaluationError extends Error {
  transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "EvaluationError";
    this.transient = transient;
  }
}

export async function evaluatePitch(params: {
  sessionId: string;
  target: TargetMode;
  transcript: TranscriptTurn[];
  durationSeconds: number;
  metrics: SpeechMetrics;
}): Promise<EvaluationResult> {
  const userMessage = buildEvaluatorUserMessage({
    sessionId: params.sessionId,
    target: params.target,
    transcript: params.transcript,
    durationSeconds: params.durationSeconds,
    metrics: params.metrics,
  });

  let lastError: EvaluationError | null = null;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await attemptEvaluation(userMessage, params.target, params.sessionId);
    } catch (err) {
      const evalErr =
        err instanceof EvaluationError ? err : new EvaluationError((err as Error).message, false);
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
