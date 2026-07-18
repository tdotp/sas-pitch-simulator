// Slow-lane evaluation: sends transcript + metrics + rubric to Claude Sonnet via
// OpenRouter and parses the structured JSON verdict. Never runs during the live
// conversation.

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

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `OpenRouter evaluation failed (${res.status}): ${body.slice(0, 400)}`
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("OpenRouter returned empty content");

  let parsed: EvaluationResult;
  try {
    parsed = JSON.parse(extractJson(content)) as EvaluationResult;
  } catch (err) {
    throw new Error(
      `No se pudo parsear el JSON del evaluador: ${(err as Error).message}. Respuesta: ${content.slice(0, 300)}`
    );
  }

  // Ensure identifiers are present/consistent regardless of model behavior.
  parsed.session_id = params.sessionId;
  parsed.target_mode = params.target;
  return parsed;
}
