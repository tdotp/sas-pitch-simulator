// Structural (Zod) validation tests for the Phase 5 config schemas.
import { describe, it, expect } from "vitest";
import {
  EvaluationFrameworkSchema,
  InterviewerProfileSchema,
  ScenarioSchema,
  ClientConfigSchema,
  ContentSourceSchema,
  ManifestSchema,
} from "./schema.js";

function validCriteria() {
  return [
    { id: "a", name: "A", weight: 60, description: "desc a" },
    { id: "b", name: "B", weight: 40, description: "desc b" },
  ];
}

describe("EvaluationFrameworkSchema", () => {
  it("accepts a valid framework whose criteria weights sum to maxScore", () => {
    const result = EvaluationFrameworkSchema.safeParse({
      id: "generic-v1",
      name: "Generic",
      maxScore: 100,
      criteria: validCriteria(),
      evaluationInstructions: "instructions",
    });
    expect(result.success).toBe(true);
  });

  it("rejects criteria whose weights don't sum to maxScore (WEIGHTS_SUM_RULE)", () => {
    const result = EvaluationFrameworkSchema.safeParse({
      id: "bad",
      name: "Bad",
      maxScore: 100,
      criteria: [{ id: "a", name: "A", weight: 50, description: "x" }],
      evaluationInstructions: "instructions",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("WEIGHTS_SUM_RULE"))).toBe(true);
    }
  });

  it("rejects duplicate criterion ids", () => {
    const result = EvaluationFrameworkSchema.safeParse({
      id: "dup",
      name: "Dup",
      maxScore: 100,
      criteria: [
        { id: "a", name: "A", weight: 50, description: "x" },
        { id: "a", name: "A2", weight: 50, description: "y" },
      ],
      evaluationInstructions: "instructions",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("duplicados"))).toBe(true);
    }
  });

  it("rejects a negative or zero criterion weight", () => {
    const result = EvaluationFrameworkSchema.safeParse({
      id: "neg",
      name: "Neg",
      maxScore: 100,
      criteria: [{ id: "a", name: "A", weight: 0, description: "x" }],
      evaluationInstructions: "instructions",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing evaluationInstructions", () => {
    const result = EvaluationFrameworkSchema.safeParse({
      id: "no-instr",
      name: "No instr",
      maxScore: 100,
      criteria: validCriteria(),
    });
    expect(result.success).toBe(false);
  });
});

describe("InterviewerProfileSchema", () => {
  function baseProfile(overrides: Record<string, unknown> = {}) {
    return {
      id: "c-level-generic",
      name: "Generic",
      persona: "persona text",
      tone: "tone text",
      questioningBehavior: "behavior text",
      followUpBehavior: { requiredCount: 2, specificQuestions: [], sharedQuestions: ["q1"] },
      voice: { slot: "random" },
      ...overrides,
    };
  }

  it("accepts a valid profile", () => {
    expect(InterviewerProfileSchema.safeParse(baseProfile()).success).toBe(true);
  });

  it("rejects an invalid voice slot", () => {
    const result = InterviewerProfileSchema.safeParse(baseProfile({ voice: { slot: "robot" } }));
    expect(result.success).toBe(false);
  });

  it("defaults followUpBehavior.requiredCount when omitted", () => {
    const result = InterviewerProfileSchema.safeParse(
      baseProfile({ followUpBehavior: { specificQuestions: [], sharedQuestions: [] } })
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.followUpBehavior.requiredCount).toBe(2);
  });

  it("rejects an id that isn't lowercase alphanumeric/kebab/snake", () => {
    const result = InterviewerProfileSchema.safeParse(baseProfile({ id: "Not Valid Id!" }));
    expect(result.success).toBe(false);
  });
});

describe("ScenarioSchema", () => {
  function baseScenario(overrides: Record<string, unknown> = {}) {
    return {
      id: "generic",
      name: "Generic",
      description: "desc",
      interviewerProfileId: "c-level-generic",
      evaluationFrameworkId: "generic-v1",
      contentSourceIds: ["playbook-sas"],
      timing: { idealSeconds: 90, maxSeconds: 180 },
      firstMessage: "hola",
      openingContext: "context",
      closingMessage: "closing",
      ...overrides,
    };
  }

  it("accepts a valid scenario", () => {
    expect(ScenarioSchema.safeParse(baseScenario()).success).toBe(true);
  });

  it("allows an underscore id for backward compat (grupo_aval)", () => {
    expect(ScenarioSchema.safeParse(baseScenario({ id: "grupo_aval" })).success).toBe(true);
  });

  it("rejects negative timing", () => {
    const result = ScenarioSchema.safeParse(baseScenario({ timing: { idealSeconds: -1, maxSeconds: 180 } }));
    expect(result.success).toBe(false);
  });

  it("defaults contentSourceIds to an empty array", () => {
    const { contentSourceIds, ...rest } = baseScenario();
    const result = ScenarioSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contentSourceIds).toEqual([]);
  });
});

describe("ClientConfigSchema", () => {
  it("accepts a minimal client config", () => {
    const result = ClientConfigSchema.safeParse({ organizationId: "sas-colombia" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.defaultLanguage).toBe("es");
  });
});

describe("ContentSourceSchema", () => {
  it("rejects an unknown content type", () => {
    const result = ContentSourceSchema.safeParse({
      id: "x",
      type: "not_a_real_type",
      title: "t",
      body: "b",
    });
    expect(result.success).toBe(false);
  });
});

describe("ManifestSchema", () => {
  it("requires at least one scenario declared", () => {
    const result = ManifestSchema.safeParse({
      organizationId: "sas-colombia",
      version: "v1",
      interviewerProfiles: ["x"],
      scenarios: [],
      evaluationFrameworks: ["x"],
    });
    expect(result.success).toBe(false);
  });
});
