// Proves getSignedUrl/buildOverrides consume a ResolvedScenarioConfig —
// no TargetMode parameter, no branching on organization/scenario id. This
// is the concrete evidence for ELEVENLABS_INTEGRATION in
// PHASE_05_ENGINE_CONFIG_REPORT.md.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    elevenlabs: {
      apiKey: "test-key",
      agentId: "agent-1",
      voices: { male: "voice-male", female: "voice-female", genericA: "voice-a", genericB: "voice-b" },
    },
  },
}));

const { getSignedUrl, buildOverrides } = await import("./elevenlabs.js");

function resolvedFor(organizationId: string, voiceSlot: "male" | "female" | "random" = "random") {
  return {
    organizationId,
    configVersion: "v1",
    configHash: "fake-hash",
    client: { organizationId, defaultLanguage: "es", settings: {} },
    scenario: {
      id: "s1",
      name: `Scenario ${organizationId}`,
      description: "d",
      interviewerProfileId: "p1",
      evaluationFrameworkId: "f1",
      contentSourceIds: [],
      timing: { idealSeconds: 90, maxSeconds: 180 },
      firstMessage: `FIRST MESSAGE ${organizationId}`,
      openingContext: "ctx",
      closingMessage: "bye",
    },
    interviewerProfile: {
      id: "p1",
      name: "P",
      persona: `PERSONA ${organizationId}`,
      tone: "tone",
      questioningBehavior: "behavior",
      followUpBehavior: { requiredCount: 1, specificQuestions: [], sharedQuestions: [] },
      voice: { slot: voiceSlot },
    },
    evaluationFramework: {
      id: "f1",
      name: "F",
      maxScore: 100,
      criteria: [{ id: "a", name: "A", weight: 100, description: "d" }],
      observableRules: [],
      requirements: [],
      mustReward: [],
      mustPenalize: [],
      evaluationInstructions: "instructions",
    },
    contentSources: [],
  } as import("../engine-config/schema.js").ResolvedScenarioConfig;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("buildOverrides", () => {
  it("builds agent overrides from the resolved config's prompt/first message/language", () => {
    const overrides = buildOverrides(resolvedFor("org-a"), "voice-123");
    expect(overrides.agent.prompt.prompt).toContain("PERSONA org-a");
    expect(overrides.agent.first_message).toBe("FIRST MESSAGE org-a");
    expect(overrides.agent.language).toBe("es");
    expect(overrides.tts.voice_id).toBe("voice-123");
  });
});

describe("getSignedUrl", () => {
  it("resolves the voice from InterviewerProfile.voice.slot, not a TargetMode", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ signed_url: "wss://example.test/signed" }),
    });

    const male = await getSignedUrl(resolvedFor("org-a", "male"));
    expect(male.voice_id).toBe("voice-male");
    expect(male.voice_gender).toBe("male");

    const female = await getSignedUrl(resolvedFor("org-a", "female"));
    expect(female.voice_id).toBe("voice-female");
    expect(female.voice_gender).toBe("female");
  });

  it("an explicit request override wins over the profile's configured slot", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ signed_url: "wss://example.test/signed" }),
    });

    const result = await getSignedUrl(resolvedFor("org-a", "male"), "female");
    expect(result.voice_gender).toBe("female");
  });

  it("produces distinct overrides for two different organizations from the same function, no hardcoded branch", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ signed_url: "wss://example.test/signed" }),
    });

    const a = await getSignedUrl(resolvedFor("org-a", "male"));
    const b = await getSignedUrl(resolvedFor("org-b", "female"));

    expect(a.overrides.agent.prompt.prompt).toContain("org-a");
    expect(a.overrides.agent.prompt.prompt).not.toContain("org-b");
    expect(b.overrides.agent.prompt.prompt).toContain("org-b");
    expect(b.overrides.agent.prompt.prompt).not.toContain("org-a");
  });
});
