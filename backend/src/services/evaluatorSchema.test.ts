// Fase 7: runtime + semantic validation of the raw OpenRouter/LLM
// evaluation response. Two separate concerns, two separate functions:
//   - LlmEvaluationResponseSchema (structural: right shape/types)
//   - validateEvaluationContract (semantic: matches the PINNED
//     EvaluationFramework — criteria/requirements coverage, score ranges)
// See PHASE_07_RELIABILITY_PROVIDER_HARDENING_REPORT.md.
import { describe, it, expect } from "vitest";
import { LlmEvaluationResponseSchema, validateEvaluationContract } from "./evaluatorSchema.js";
import type { EvaluationFramework } from "../engine-config/schema.js";

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    overall_score: 80,
    readiness_level: "alto",
    one_line_diagnosis: "Buen manejo general.",
    executive_summary: "Resumen ejecutivo.",
    duration: {
      seconds: 90,
      formatted: "1:30",
      ideal_seconds: 90,
      max_seconds: 180,
      status: "ideal",
      comment: "Duración ideal.",
    },
    detected_requirements: [{ id: "mentioned_sas", detected: true, evidence: "cita 1" }],
    speech_metrics: {
      word_count: 120,
      words_per_minute: 130,
      filler_words_total: 2,
      top_filler_words: ["eh"],
      repetition_count: 0,
      top_repetitions: [],
      long_pauses_count: 0,
      used_numbers: true,
      numbers_detected: ["30%"],
      has_cta: true,
      comment: "Buen ritmo.",
    },
    criteria_scores: [
      {
        criterion_id: "claridad",
        criterion_name: "Claridad",
        score: 80,
        max_score: 100,
        evidence: "evidencia",
        comment: "comentario",
        recommendation: "recomendación",
      },
    ],
    strengths: ["Claro"],
    improvement_areas: ["Ritmo"],
    critical_flags: [],
    missed_opportunities: [],
    best_line_from_user: "línea",
    weakest_line_from_user: "línea débil",
    recommended_pitch_90_seconds: "pitch 90",
    recommended_pitch_45_seconds: "pitch 45",
    recommended_cta: "cta",
    next_training_focus: ["foco"],
    coach_feedback: "feedback",
    ...overrides,
  };
}

function framework(overrides: Partial<EvaluationFramework> = {}): EvaluationFramework {
  return {
    id: "f1",
    name: "F",
    maxScore: 100,
    criteria: [{ id: "claridad", name: "Claridad", weight: 100, description: "d" }],
    observableRules: [],
    requirements: [{ id: "mentioned_sas", description: "Menciona SAS." }],
    durationPolicy: undefined,
    mustReward: [],
    mustPenalize: [],
    evaluationInstructions: "instrucciones",
    ...overrides,
  };
}

describe("LlmEvaluationResponseSchema", () => {
  it("accepts a well-formed full response", () => {
    const result = LlmEvaluationResponseSchema.safeParse(validResponse());
    expect(result.success).toBe(true);
  });

  it("rejects a response missing required fields (wrong shape)", () => {
    const { criteria_scores: _drop, ...missingCriteria } = validResponse();
    const result = LlmEvaluationResponseSchema.safeParse(missingCriteria);
    expect(result.success).toBe(false);
  });

  it("rejects a response with wrong field types", () => {
    const result = LlmEvaluationResponseSchema.safeParse(
      validResponse({ overall_score: "eighty" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown readiness_level value", () => {
    const result = LlmEvaluationResponseSchema.safeParse(
      validResponse({ readiness_level: "excelente" })
    );
    expect(result.success).toBe(false);
  });

  it("rejects criteria_scores that isn't a non-empty array", () => {
    const result = LlmEvaluationResponseSchema.safeParse(validResponse({ criteria_scores: [] }));
    expect(result.success).toBe(false);
  });
});

describe("validateEvaluationContract", () => {
  it("returns no violations when criteria and requirements match the framework exactly", () => {
    const parsed = LlmEvaluationResponseSchema.parse(validResponse());
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations).toEqual([]);
  });

  it("flags an unknown criterion_id", () => {
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        criteria_scores: [
          {
            criterion_id: "unknown_criterion",
            criterion_name: "?",
            score: 10,
            max_score: 100,
            evidence: "e",
            comment: "c",
            recommendation: "r",
          },
        ],
      })
    );
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.includes("unknown_criterion"))).toBe(true);
  });

  it("flags a missing criterion declared by the framework", () => {
    const fw = framework({
      criteria: [
        { id: "claridad", name: "Claridad", weight: 50, description: "d" },
        { id: "estructura", name: "Estructura", weight: 50, description: "d" },
      ],
    });
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        criteria_scores: [
          {
            criterion_id: "claridad",
            criterion_name: "Claridad",
            score: 40,
            max_score: 50,
            evidence: "e",
            comment: "c",
            recommendation: "r",
          },
        ],
      })
    );
    const violations = validateEvaluationContract(parsed, fw);
    expect(violations.some((v) => v.includes("estructura"))).toBe(true);
  });

  it("flags a duplicate criterion_id", () => {
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        criteria_scores: [
          {
            criterion_id: "claridad",
            criterion_name: "Claridad",
            score: 40,
            max_score: 100,
            evidence: "e",
            comment: "c",
            recommendation: "r",
          },
          {
            criterion_id: "claridad",
            criterion_name: "Claridad",
            score: 30,
            max_score: 100,
            evidence: "e",
            comment: "c",
            recommendation: "r",
          },
        ],
      })
    );
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.toLowerCase().includes("duplicad"))).toBe(true);
  });

  it("flags criterion max_score that doesn't match the framework's weight", () => {
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        criteria_scores: [
          {
            criterion_id: "claridad",
            criterion_name: "Claridad",
            score: 40,
            max_score: 60,
            evidence: "e",
            comment: "c",
            recommendation: "r",
          },
        ],
      })
    );
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.includes("max_score"))).toBe(true);
  });

  it("flags a criterion score outside [0, max_score]", () => {
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        criteria_scores: [
          {
            criterion_id: "claridad",
            criterion_name: "Claridad",
            score: 150,
            max_score: 100,
            evidence: "e",
            comment: "c",
            recommendation: "r",
          },
        ],
      })
    );
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.includes("rango"))).toBe(true);
  });

  it("flags overall_score outside [0, framework.maxScore]", () => {
    const parsed = LlmEvaluationResponseSchema.parse(validResponse({ overall_score: 150 }));
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.includes("overall_score"))).toBe(true);
  });

  it("flags an unknown requirement id", () => {
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        detected_requirements: [{ id: "unexpected_id", detected: true, evidence: "x" }],
      })
    );
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.includes("unexpected_id"))).toBe(true);
  });

  it("flags a missing requirement declared by the framework", () => {
    const parsed = LlmEvaluationResponseSchema.parse(validResponse({ detected_requirements: [] }));
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.includes("mentioned_sas"))).toBe(true);
  });

  it("flags a duplicate requirement id", () => {
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        detected_requirements: [
          { id: "mentioned_sas", detected: true, evidence: "a" },
          { id: "mentioned_sas", detected: false, evidence: "b" },
        ],
      })
    );
    const violations = validateEvaluationContract(parsed, framework());
    expect(violations.some((v) => v.toLowerCase().includes("duplicad"))).toBe(true);
  });

  it("requires detected_requirements to be empty when the framework declares no requirements", () => {
    const fw = framework({ requirements: [] });
    const parsed = LlmEvaluationResponseSchema.parse(
      validResponse({
        detected_requirements: [{ id: "anything", detected: true, evidence: "x" }],
      })
    );
    const violations = validateEvaluationContract(parsed, fw);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("passes with an empty detected_requirements when the framework declares none", () => {
    const fw = framework({ requirements: [] });
    const parsed = LlmEvaluationResponseSchema.parse(validResponse({ detected_requirements: [] }));
    const violations = validateEvaluationContract(parsed, fw);
    expect(violations).toEqual([]);
  });
});
