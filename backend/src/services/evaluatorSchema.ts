// Fase 7: runtime + semantic validation of the raw OpenRouter evaluator
// response. Replaces the old `JSON.parse(...) as EvaluationResult` cast in
// evaluator.ts, which trusted the model's output shape blindly.
//
// Two separate, deliberately independent checks:
//   - LlmEvaluationResponseSchema: STRUCTURAL. Does the JSON have the right
//     shape and types at all? Framework-agnostic — the same schema for
//     every client. A failure here is OPENROUTER_INVALID_RESPONSE_SCHEMA.
//   - validateEvaluationContract: SEMANTIC. Given a shape-valid response,
//     does it actually match the PINNED EvaluationFramework this session
//     was evaluated against (criteria/requirements coverage, score
//     ranges)? A failure here is OPENROUTER_INVALID_EVALUATION_CONTRACT.
//
// Neither throws — evaluator.ts decides how to turn a schema failure or a
// non-empty violations list into an EvaluationError, since only it knows
// the safe error category and safe message truncation rules.
import { z } from "zod";
import type { EvaluationFramework } from "../engine-config/schema.js";

const DurationOutputSchema = z.object({
  seconds: z.number(),
  formatted: z.string(),
  ideal_seconds: z.number(),
  max_seconds: z.number(),
  status: z.enum(["ideal", "aceptable", "largo", "fuera_de_rango"]),
  comment: z.string(),
});

// Deliberately NOT `description` — the prompt tells the model never to
// include one (evaluatorPromptBuilder.ts), and evaluator.ts's
// enrichDetectedRequirements() is the ONE place description gets attached,
// always from the framework, never from the model.
const DetectedRequirementOutputSchema = z.object({
  id: z.string(),
  detected: z.boolean(),
  evidence: z.string(),
});

const SpeechMetricsOutputSchema = z.object({
  word_count: z.number(),
  words_per_minute: z.number(),
  filler_words_total: z.number(),
  top_filler_words: z.array(z.string()),
  repetition_count: z.number(),
  top_repetitions: z.array(z.string()),
  long_pauses_count: z.number(),
  used_numbers: z.boolean(),
  numbers_detected: z.array(z.string()),
  has_cta: z.boolean(),
  comment: z.string(),
});

const CriterionScoreOutputSchema = z.object({
  criterion_id: z.string(),
  criterion_name: z.string(),
  score: z.number(),
  max_score: z.number(),
  evidence: z.string(),
  comment: z.string(),
  recommendation: z.string(),
});

const CriticalFlagOutputSchema = z.object({
  flag: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  comment: z.string(),
});

// session_id/target_mode are deliberately absent: attemptEvaluation()
// overwrites both unconditionally right after parsing (see
// evaluator.ts), so whatever the model returns for them is never used —
// validating them would only create spurious rejections.
export const LlmEvaluationResponseSchema = z.object({
  overall_score: z.number(),
  readiness_level: z.enum(["bajo", "medio", "alto", "sobresaliente"]),
  one_line_diagnosis: z.string(),
  executive_summary: z.string(),
  duration: DurationOutputSchema,
  detected_requirements: z.array(DetectedRequirementOutputSchema),
  speech_metrics: SpeechMetricsOutputSchema,
  criteria_scores: z.array(CriterionScoreOutputSchema).min(1),
  strengths: z.array(z.string()),
  improvement_areas: z.array(z.string()),
  critical_flags: z.array(CriticalFlagOutputSchema),
  missed_opportunities: z.array(z.string()),
  best_line_from_user: z.string(),
  weakest_line_from_user: z.string(),
  recommended_pitch_90_seconds: z.string(),
  recommended_pitch_45_seconds: z.string(),
  recommended_cta: z.string(),
  next_training_focus: z.array(z.string()),
  coach_feedback: z.string(),
});

export type LlmEvaluationResponse = z.infer<typeof LlmEvaluationResponseSchema>;

// Weight/score comparisons use cents-of-a-point precision (×100, rounded)
// to avoid floating point equality issues — same technique already used
// by EvaluationFrameworkSchema's WEIGHTS_SUM_RULE in engine-config/schema.ts.
function approxEqual(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

// Semantic validation against the PINNED framework. Returns a list of
// human-readable violation strings (empty = valid) rather than throwing,
// so the caller controls how they get folded into a safe error message.
export function validateEvaluationContract(
  result: LlmEvaluationResponse,
  framework: EvaluationFramework
): string[] {
  const violations: string[] = [];

  const criteriaById = new Map(framework.criteria.map((c) => [c.id, c]));
  const seenCriteria = new Set<string>();
  for (const cs of result.criteria_scores) {
    if (seenCriteria.has(cs.criterion_id)) {
      violations.push(`criterion_id duplicado: ${cs.criterion_id}`);
      continue;
    }
    seenCriteria.add(cs.criterion_id);
    const expected = criteriaById.get(cs.criterion_id);
    if (!expected) {
      violations.push(`criterion_id desconocido (no declarado por el framework): ${cs.criterion_id}`);
      continue;
    }
    if (!approxEqual(cs.max_score, expected.weight)) {
      violations.push(
        `max_score de ${cs.criterion_id} es ${cs.max_score}, se esperaba ${expected.weight} (framework weight)`
      );
    }
    if (cs.score < 0 || cs.score > cs.max_score) {
      violations.push(`score de ${cs.criterion_id} fuera de rango: ${cs.score} (max ${cs.max_score})`);
    }
  }
  for (const id of criteriaById.keys()) {
    if (!seenCriteria.has(id)) violations.push(`falta criterion_id declarado por el framework: ${id}`);
  }

  const requirementIds = new Set(framework.requirements.map((r) => r.id));
  const seenRequirements = new Set<string>();
  for (const dr of result.detected_requirements) {
    if (seenRequirements.has(dr.id)) {
      violations.push(`requirement id duplicado: ${dr.id}`);
      continue;
    }
    seenRequirements.add(dr.id);
    if (!requirementIds.has(dr.id)) {
      violations.push(`requirement id desconocido (no declarado por el framework): ${dr.id}`);
    }
  }
  for (const id of requirementIds) {
    if (!seenRequirements.has(id)) violations.push(`falta requirement id declarado por el framework: ${id}`);
  }

  if (result.overall_score < 0 || result.overall_score > framework.maxScore) {
    violations.push(`overall_score fuera de rango: ${result.overall_score} (max ${framework.maxScore})`);
  }

  return violations;
}
