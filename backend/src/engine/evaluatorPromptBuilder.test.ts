// Proves the evaluator prompt builder consumes a resolved
// EvaluationFramework generically — no fixed rubric text, no
// organization/scenario branching. This is the concrete evidence for
// EVALUATOR_INTEGRATION in PHASE_05_ENGINE_CONFIG_REPORT.md.
import { describe, it, expect } from "vitest";
import {
  buildEvaluatorSystemPrompt,
  buildEvaluatorUserMessage,
  ENGINE_EVALUATOR_SYSTEM_PROMPT,
} from "./evaluatorPromptBuilder.js";
import type { ResolvedScenarioConfig } from "../engine-config/schema.js";

function resolvedWithFramework(organizationId: string, criteria: Array<{ id: string; weight: number }>): ResolvedScenarioConfig {
  return {
    organizationId,
    client: { organizationId, defaultLanguage: "es", settings: {} },
    scenario: {
      id: "s1",
      name: `Scenario ${organizationId}`,
      description: `description for ${organizationId}`,
      interviewerProfileId: "p1",
      evaluationFrameworkId: "f1",
      contentSourceIds: [],
      timing: { idealSeconds: 90, maxSeconds: 180 },
      firstMessage: "hi",
      openingContext: "ctx",
      closingMessage: "bye",
    },
    interviewerProfile: {
      id: "p1",
      name: "P",
      persona: "persona",
      tone: "tone",
      questioningBehavior: "behavior",
      followUpBehavior: { requiredCount: 1, specificQuestions: [], sharedQuestions: [] },
      voice: { slot: "random" },
    },
    evaluationFramework: {
      id: `framework-${organizationId}`,
      name: `Framework for ${organizationId}`,
      maxScore: 100,
      criteria: criteria.map((c) => ({ id: c.id, name: c.id, weight: c.weight, description: `desc ${c.id}` })),
      observableRules: [`rule for ${organizationId}`],
      mustReward: [],
      mustPenalize: [],
      evaluationInstructions: `SPECIAL INSTRUCTIONS FOR ${organizationId}`,
    },
    contentSources: [],
  };
}

const metrics = {
  word_count: 10,
  words_per_minute: 100,
  filler_words_total: 0,
  filler_words_items: {},
  repetition_count: 0,
  repetition_items: [],
  long_pauses_count: 0,
  mentioned_sas: true,
  used_numbers: true,
  numbers_detected: [],
  has_cta: true,
} as import("../types.js").SpeechMetrics;

describe("buildEvaluatorSystemPrompt", () => {
  it("appends the framework's evaluationInstructions to the universal engine prompt", () => {
    const resolved = resolvedWithFramework("org-a", [{ id: "x", weight: 100 }]);
    const prompt = buildEvaluatorSystemPrompt(resolved);
    expect(prompt).toContain(ENGINE_EVALUATOR_SYSTEM_PROMPT);
    expect(prompt).toContain("SPECIAL INSTRUCTIONS FOR org-a");
  });

  it("never hardcodes a fixed rubric — two different frameworks produce different prompts", () => {
    const a = buildEvaluatorSystemPrompt(resolvedWithFramework("org-a", [{ id: "x", weight: 100 }]));
    const b = buildEvaluatorSystemPrompt(resolvedWithFramework("org-b", [{ id: "y", weight: 100 }]));
    expect(a).not.toContain("org-b");
    expect(b).not.toContain("org-a");
  });
});

describe("buildEvaluatorUserMessage", () => {
  it("serializes the resolved framework's criteria/weights, not a fixed SAS rubric", () => {
    const resolved = resolvedWithFramework("org-a", [
      { id: "custom_criterion_one", weight: 60 },
      { id: "custom_criterion_two", weight: 40 },
    ]);
    const message = buildEvaluatorUserMessage({
      sessionId: "s1",
      resolved,
      transcript: [{ role: "user", text: "hola" }],
      durationSeconds: 30,
      metrics,
    });

    expect(message).toContain("custom_criterion_one");
    expect(message).toContain("custom_criterion_two");
    expect(message).toContain(`"weight": 60`);
    expect(message).not.toContain("message_clarity"); // old hardcoded SAS rubric criterion id
    expect(message).not.toContain("playbook_alignment"); // old hardcoded SAS rubric criterion id
  });

  it("includes the scenario description and transcript, scoped to the resolved config only", () => {
    const resolved = resolvedWithFramework("org-b", [{ id: "z", weight: 100 }]);
    const message = buildEvaluatorUserMessage({
      sessionId: "s2",
      resolved,
      transcript: [{ role: "agent", text: "pregunta" }, { role: "user", text: "respuesta" }],
      durationSeconds: 45,
      metrics,
    });

    expect(message).toContain("description for org-b");
    expect(message).toContain("respuesta");
  });
});
