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
import { FileConfigPackageLoader } from "../engine-config/loader.js";
import { resolveScenarioConfigForVersion } from "../engine-config/resolver.js";

function resolvedWithFramework(
  organizationId: string,
  criteria: Array<{ id: string; weight: number }>,
  requirements: Array<{ id: string; description: string }> = []
): ResolvedScenarioConfig {
  return {
    organizationId,
    configVersion: "v1",
    configHash: "fake-hash",
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
      requirements,
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

// PHASE_05_FIXES_ADDENDUM item 5: concrete proof the removed SAS-specific
// fields (mentioned_sas, aligned_to_playbook) are gone from the universal
// output contract, that requirements are config-driven, and that
// transcript serialization never depends on a fixed human name.
describe("PASS_WITH_FIXES: generic detected_requirements contract", () => {
  it("two frameworks with different requirements produce different prompt content with zero code branching", () => {
    const sas = resolvedWithFramework("sas-colombia", [{ id: "x", weight: 100 }], [
      { id: "mentioned_sas", description: "Menciona SAS de forma natural." },
      { id: "aligned_to_playbook", description: "Alineado con la narrativa SAS." },
    ]);
    const acme = resolvedWithFramework("acme-demo", [{ id: "y", weight: 100 }], [
      { id: "verifiable_data", description: "Incluye un dato verificable." },
    ]);

    const sasMessage = buildEvaluatorUserMessage({
      sessionId: "s1",
      resolved: sas,
      transcript: [{ role: "user", text: "hola" }],
      durationSeconds: 30,
      metrics,
    });
    const acmeMessage = buildEvaluatorUserMessage({
      sessionId: "s2",
      resolved: acme,
      transcript: [{ role: "user", text: "hola" }],
      durationSeconds: 30,
      metrics,
    });

    expect(sasMessage).toContain("mentioned_sas");
    expect(sasMessage).toContain("aligned_to_playbook");
    expect(sasMessage).not.toContain("verifiable_data");

    expect(acmeMessage).toContain("verifiable_data");
    expect(acmeMessage).not.toContain("mentioned_sas");
    expect(acmeMessage).not.toContain("aligned_to_playbook");
  });

  it("the OUTPUT_SCHEMA contract (detected_requirements shape) is identical across frameworks", () => {
    const sas = resolvedWithFramework("sas-colombia", [{ id: "x", weight: 100 }], [
      { id: "mentioned_sas", description: "d" },
    ]);
    const acme = resolvedWithFramework("acme-demo", [{ id: "y", weight: 100 }], [
      { id: "verifiable_data", description: "d" },
    ]);
    const extractSchema = (msg: string) => msg.slice(msg.indexOf('"detected_requirements"'));
    const sasSchema = extractSchema(
      buildEvaluatorUserMessage({ sessionId: "s1", resolved: sas, transcript: [], durationSeconds: 30, metrics })
    );
    const acmeSchema = extractSchema(
      buildEvaluatorUserMessage({ sessionId: "s2", resolved: acme, transcript: [], durationSeconds: 30, metrics })
    );
    expect(sasSchema).toBe(acmeSchema);
    expect(sasSchema).not.toMatch(/"mentioned_sas":\s*true/);
    expect(sasSchema).not.toMatch(/"aligned_to_playbook":\s*true/);
  });

  it("never serializes a fixed human name (SANDRA) — uses neutral role labels instead", () => {
    const resolved = resolvedWithFramework("org-a", [{ id: "x", weight: 100 }]);
    const message = buildEvaluatorUserMessage({
      sessionId: "s1",
      resolved,
      transcript: [
        { role: "agent", text: "¿Qué está haciendo distinto este año?" },
        { role: "user", text: "Buenas, mi nombre no importa aquí." },
      ],
      durationSeconds: 30,
      metrics,
    });
    expect(message).not.toContain("SANDRA");
    expect(message).toContain("VOCERO: Buenas");
    expect(message).toContain("ENTREVISTADOR: ¿Qué está haciendo");
  });

  it("acme-demo's real config package produces no 'mentioned_sas' and no literal SAS text anywhere in the built prompts", async () => {
    const loader = new FileConfigPackageLoader();
    const resolved = await resolveScenarioConfigForVersion(
      { organizationId: "acme-demo", scenarioId: "generic", configVersion: "v1" },
      { loader }
    );
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome !== "resolved") return;

    const systemPrompt = buildEvaluatorSystemPrompt(resolved.config);
    const userMessage = buildEvaluatorUserMessage({
      sessionId: "s1",
      resolved: resolved.config,
      transcript: [{ role: "user", text: "Vamos a mejorar la logística." }],
      durationSeconds: 30,
      metrics,
    });

    expect(systemPrompt).not.toMatch(/\bSAS\b/);
    expect(userMessage).not.toMatch(/\bSAS\b/);
    expect(userMessage).not.toContain("mentioned_sas");
    expect(userMessage).not.toContain("aligned_to_playbook");
    expect(userMessage).toContain("verifiable_data"); // acme's own, different requirement
  });
});
