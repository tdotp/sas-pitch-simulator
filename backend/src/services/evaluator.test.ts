// Unit tests for evaluatePitch's Phase 4 additions: explicit timeout and
// one bounded automatic retry for TRANSIENT failures only (429/5xx/
// timeout) — never for a 4xx-that-isn't-429 or a JSON parse failure.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    openrouter: {
      apiKey: "test-key",
      model: "test-model",
      siteUrl: "http://localhost",
      appName: "Test",
    },
  },
}));

vi.mock("../engine/evaluatorPromptBuilder.js", () => ({
  buildEvaluatorSystemPrompt: () => "system prompt",
  buildEvaluatorUserMessage: () => "user message",
}));

const { evaluatePitch, EvaluationError } = await import("./evaluator.js");

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function okOpenRouterResponse(overall_score = 80) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify({ overall_score }) } }],
  });
}

// Phase 5: evaluatePitch takes a resolved scenario config, not a
// TargetMode — this file only needs a minimal fixture since
// buildEvaluatorSystemPrompt/buildEvaluatorUserMessage are mocked above
// (they're tested for real in engine/evaluatorPromptBuilder.test.ts).
const minimalResolved = {
  organizationId: "org-test",
  client: { organizationId: "org-test", defaultLanguage: "es", settings: {} },
  scenario: {
    id: "generic",
    name: "Generic",
    description: "d",
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
    voice: { slot: "random" as const },
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

const baseParams = {
  sessionId: "s1",
  resolved: minimalResolved,
  transcript: [{ role: "user" as const, text: "hola" }],
  durationSeconds: 30,
  metrics: {
    word_count: 5,
    words_per_minute: 100,
    filler_words_total: 0,
    filler_words_items: {},
    repetition_count: 0,
    repetition_items: [],
    long_pauses_count: 0,
    used_numbers: true,
    numbers_detected: [],
    has_cta: true,
  },
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.useRealTimers();
});

describe("evaluatePitch", () => {
  it("returns the parsed evaluation on a clean 200", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okOpenRouterResponse(75));
    const result = await evaluatePitch(baseParams);
    expect(result.overall_score).toBe(75);
    expect(result.session_id).toBe("s1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once on a transient 503, then succeeds", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, false, 503))
      .mockResolvedValueOnce(okOpenRouterResponse(90));

    const result = await evaluatePitch(baseParams);
    expect(result.overall_score).toBe(90);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on a transient 429, then succeeds", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, false, 429))
      .mockResolvedValueOnce(okOpenRouterResponse(60));

    const result = await evaluatePitch(baseParams);
    expect(result.overall_score).toBe(60);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_TRANSIENT_RETRIES transient failures (max 2 attempts total)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ error: "down" }, false, 503));

    await expect(evaluatePitch(baseParams)).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 original + 1 retry, not more
  });

  it("does NOT retry a non-transient 400", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad request" }, false, 400));

    await expect(evaluatePitch(baseParams)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // PASS_WITH_FIXES: routes.ts persists only a safe category as
  // failure_reason (never the raw OpenRouter body) — verify the
  // classification is correct for the cases that matter operationally.
  it("classifies a timeout as OPENROUTER_TIMEOUT", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    vi.useFakeTimers();
    // Attach the rejection handler synchronously, before any timer
    // advance runs — otherwise Node can briefly see the eventual
    // rejection as "unhandled" (it's handled a tick later by the
    // try/catch below), which vitest treats as a real test error even
    // though the test itself passes.
    const outcome = evaluatePitch(baseParams).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, err })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await outcome;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(EvaluationError);
      expect((result.err as InstanceType<typeof EvaluationError>).category).toBe("OPENROUTER_TIMEOUT");
    }
  });

  it("classifies a 503 as OPENROUTER_5XX and a 429 as OPENROUTER_RATE_LIMITED", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ error: "down" }, false, 503));
    let caught: unknown;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe("OPENROUTER_5XX");

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ error: "rate limited" }, false, 429));
    caught = undefined;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe("OPENROUTER_RATE_LIMITED");
  });

  it("classifies a non-429 4xx as OPENROUTER_4XX and a JSON parse failure as OPENROUTER_INVALID_JSON", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad request" }, false, 400));
    let caught: unknown;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe("OPENROUTER_4XX");

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: "not valid json {{{" } }] })
    );
    caught = undefined;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe("OPENROUTER_INVALID_JSON");
  });

  it("the thrown error's message may carry raw upstream detail, but the category never does", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    // mockResolvedValue (not Once): a 500 is transient, so evaluatePitch
    // retries once — both attempts need a response queued.
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "sensitive upstream detail: internal-host-123" }, false, 500)
    );
    let caught: unknown;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    const evalErr = caught as InstanceType<typeof EvaluationError>;
    expect(evalErr.category).toBe("OPENROUTER_5XX");
    expect(evalErr.category).not.toContain("internal-host-123");
  });

  it("does NOT retry a JSON parse failure", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: "not valid json {{{" } }] })
    );

    await expect(evaluatePitch(baseParams)).rejects.toThrow(/parsear/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out and retries once (timeout counts as transient)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
      .mockResolvedValueOnce(okOpenRouterResponse(70));

    // Force the timeout to fire almost immediately for this test instead
    // of waiting the real 30s.
    vi.useFakeTimers();
    const promise = evaluatePitch(baseParams);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1_000); // retry backoff
    const result = await promise;
    vi.useRealTimers();

    expect(result.overall_score).toBe(70);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
