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

const logEvent = vi.fn();
vi.mock("../observability/log.js", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
  elapsedMs: (start: number) => Date.now() - start,
}));

const { getSignedUrl, buildOverrides, ElevenLabsError } = await import("./elevenlabs.js");

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
  logEvent.mockClear();
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

  // Fase 7: response validation — a 200 is not automatically a success.
  it("rejects a 200 response whose body is missing signed_url, as ELEVENLABS_INVALID_RESPONSE", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "{}",
      json: async () => ({}),
    });

    let caught: unknown;
    try {
      await getSignedUrl(resolvedFor("org-a"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ElevenLabsError);
    expect((caught as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_INVALID_RESPONSE");
  });

  it("rejects a 200 response whose signed_url is an empty string, as ELEVENLABS_INVALID_RESPONSE", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ signed_url: "" }),
    });

    let caught: unknown;
    try {
      await getSignedUrl(resolvedFor("org-a"));
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_INVALID_RESPONSE");
  });

  it("classifies a network error as ELEVENLABS_NETWORK_ERROR", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fetch failed"));

    let caught: unknown;
    try {
      await getSignedUrl(resolvedFor("org-a"));
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_NETWORK_ERROR");
  });

  it("classifies an AbortError (timeout) as ELEVENLABS_TIMEOUT", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
    );

    vi.useFakeTimers();
    const outcome = getSignedUrl(resolvedFor("org-a")).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err })
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(ElevenLabsError);
      expect((result.err as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_TIMEOUT");
    }
  });

  it("classifies a 429 as ELEVENLABS_RATE_LIMITED", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });

    let caught: unknown;
    try {
      await getSignedUrl(resolvedFor("org-a"));
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_RATE_LIMITED");
  });

  it("classifies a 500 as ELEVENLABS_5XX and a 400 as ELEVENLABS_4XX", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    let caught: unknown;
    try {
      await getSignedUrl(resolvedFor("org-a"));
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_5XX");

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request",
    });
    caught = undefined;
    try {
      await getSignedUrl(resolvedFor("org-a"));
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof ElevenLabsError>).category).toBe("ELEVENLABS_4XX");
  });

  // Fase 7: structured logging (observability/log.ts). Never logs the
  // signed_url itself — only latency/outcome/category.
  it("logs an elevenlabs_signed_url event with outcome success and a duration_ms, never the signed_url value", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ signed_url: "wss://example.test/super-secret-signed-path" }),
    });

    await getSignedUrl(resolvedFor("org-a"));

    expect(logEvent).toHaveBeenCalledTimes(1);
    const logged = logEvent.mock.calls[0][0];
    expect(logged).toMatchObject({ event: "elevenlabs_signed_url", provider: "elevenlabs", outcome: "success" });
    expect(typeof logged.duration_ms).toBe("number");
    expect(JSON.stringify(logged)).not.toContain("super-secret-signed-path");
  });

  it("logs an elevenlabs_signed_url event with outcome failure and the safe error_category on a 500", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });

    await expect(getSignedUrl(resolvedFor("org-a"))).rejects.toThrow();

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0]).toMatchObject({
      event: "elevenlabs_signed_url",
      provider: "elevenlabs",
      outcome: "failure",
      error_category: "ELEVENLABS_5XX",
    });
  });
});
