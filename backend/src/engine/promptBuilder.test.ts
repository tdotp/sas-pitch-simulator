// Proves buildInterviewerPrompt is generic: given two structurally
// different ResolvedScenarioConfig fixtures (different organizations,
// different persona/questions/content), it produces correct, distinct
// output using the SAME code path — no branch anywhere on organizationId
// or scenario id.
import { describe, it, expect } from "vitest";
import { buildInterviewerPrompt } from "./promptBuilder.js";
import type { ResolvedScenarioConfig } from "../engine-config/schema.js";

function resolvedFor(organizationId: string): ResolvedScenarioConfig {
  return {
    organizationId,
    client: { organizationId, defaultLanguage: "es", settings: {} },
    scenario: {
      id: "generic",
      name: `Scenario for ${organizationId}`,
      description: "d",
      interviewerProfileId: "profile-1",
      evaluationFrameworkId: "framework-1",
      contentSourceIds: ["content-1"],
      timing: { idealSeconds: 90, maxSeconds: 180 },
      firstMessage: `FIRST MESSAGE FOR ${organizationId}`,
      openingContext: `OPENING CONTEXT FOR ${organizationId}`,
      closingMessage: `CLOSING MESSAGE FOR ${organizationId}`,
    },
    interviewerProfile: {
      id: "profile-1",
      name: "Profile",
      persona: `PERSONA FOR ${organizationId}`,
      tone: `TONE FOR ${organizationId}`,
      questioningBehavior: `BEHAVIOR FOR ${organizationId}`,
      followUpBehavior: {
        requiredCount: 2,
        specificQuestions: [`SPECIFIC Q FOR ${organizationId}`],
        sharedQuestions: [`SHARED Q FOR ${organizationId}`],
      },
      voice: { slot: "random" },
    },
    evaluationFramework: {
      id: "framework-1",
      name: "Framework",
      maxScore: 100,
      criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
      observableRules: [],
      requirements: [],
      mustReward: [],
      mustPenalize: [],
      evaluationInstructions: "instructions",
    },
    contentSources: [
      { id: "content-1", type: "facts", title: `facts for ${organizationId}`, body: `CONTENT FOR ${organizationId}` },
    ],
  };
}

describe("buildInterviewerPrompt", () => {
  it("assembles the persona, opening context, follow-up flow and content for one organization", () => {
    const { systemPrompt, firstMessage } = buildInterviewerPrompt(resolvedFor("org-a"));

    expect(systemPrompt).toContain("PERSONA FOR org-a");
    expect(systemPrompt).toContain("TONE FOR org-a");
    expect(systemPrompt).toContain("BEHAVIOR FOR org-a");
    expect(systemPrompt).toContain("OPENING CONTEXT FOR org-a");
    expect(systemPrompt).toContain("CLOSING MESSAGE FOR org-a");
    expect(systemPrompt).toContain("SPECIFIC Q FOR org-a");
    expect(systemPrompt).toContain("CONTENT FOR org-a");
    expect(firstMessage).toBe("FIRST MESSAGE FOR org-a");
  });

  it("produces a structurally correct but content-distinct prompt for a second organization — no shared hardcoded branch", () => {
    const a = buildInterviewerPrompt(resolvedFor("org-a"));
    const b = buildInterviewerPrompt(resolvedFor("org-b"));

    expect(a.systemPrompt).not.toContain("org-b");
    expect(b.systemPrompt).not.toContain("org-a");
    expect(a.firstMessage).not.toBe(b.firstMessage);
  });

  it("always instructs the mandatory follow-up count from config, not a hardcoded number", () => {
    const oneQuestion = resolvedFor("org-c");
    oneQuestion.interviewerProfile.followUpBehavior.requiredCount = 1;
    const { systemPrompt } = buildInterviewerPrompt(oneQuestion);
    expect(systemPrompt).toContain("exactamente UNA");
  });

  it("supports zero required follow-ups without special-casing a client", () => {
    const zero = resolvedFor("org-d");
    zero.interviewerProfile.followUpBehavior.requiredCount = 0;
    const { systemPrompt } = buildInterviewerPrompt(zero);
    expect(systemPrompt).toContain("No hagas preguntas de seguimiento obligatorias");
  });

  it("omits the content block entirely when a scenario has no content sources", () => {
    const noContent = resolvedFor("org-e");
    noContent.contentSources = [];
    const { systemPrompt } = buildInterviewerPrompt(noContent);
    expect(systemPrompt).not.toContain("undefined");
  });
});
