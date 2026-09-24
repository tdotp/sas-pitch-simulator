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

const logEvent = vi.fn();
vi.mock("../observability/log.js", () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
  elapsedMs: (start: number) => Date.now() - start,
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

// Fase 7: a schema-valid, contract-valid LLM response — matches
// minimalResolved's framework exactly (one criterion "a"/weight 100, no
// requirements). Any test exercising the "success" path now needs a full
// shape, not just { overall_score }, since evaluator.ts runs runtime +
// semantic validation on the raw response before returning it.
function validLlmContent(overrides: Record<string, unknown> = {}) {
  return {
    overall_score: 80,
    readiness_level: "alto",
    one_line_diagnosis: "diagnóstico",
    executive_summary: "resumen",
    duration: {
      seconds: 30,
      formatted: "0:30",
      ideal_seconds: 90,
      max_seconds: 180,
      status: "aceptable",
      comment: "comentario",
    },
    detected_requirements: [],
    speech_metrics: {
      word_count: 5,
      words_per_minute: 100,
      filler_words_total: 0,
      top_filler_words: [],
      repetition_count: 0,
      top_repetitions: [],
      long_pauses_count: 0,
      used_numbers: true,
      numbers_detected: [],
      has_cta: true,
      comment: "comentario",
    },
    criteria_scores: [
      {
        criterion_id: "a",
        criterion_name: "A",
        score: 80,
        max_score: 100,
        evidence: "evidencia",
        comment: "comentario",
        recommendation: "recomendación",
      },
    ],
    strengths: [],
    improvement_areas: [],
    critical_flags: [],
    missed_opportunities: [],
    best_line_from_user: "línea",
    weakest_line_from_user: "línea",
    recommended_pitch_90_seconds: "pitch",
    recommended_pitch_45_seconds: "pitch",
    recommended_cta: "cta",
    next_training_focus: [],
    coach_feedback: "feedback",
    ...overrides,
  };
}

function okOpenRouterResponse(overall_score = 80) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(validLlmContent({ overall_score })) } }],
  });
}

// Phase 5: evaluatePitch takes a resolved scenario config, not a
// TargetMode — this file only needs a minimal fixture since
// buildEvaluatorSystemPrompt/buildEvaluatorUserMessage are mocked above
// (they're tested for real in engine/evaluatorPromptBuilder.test.ts).
const minimalResolved = {
  organizationId: "org-test",
  configVersion: "v1",
  configHash: "fake-hash",
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
  logEvent.mockClear();
});

describe("evaluatePitch", () => {
  it("returns the parsed evaluation on a clean 200", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okOpenRouterResponse(75));
    const result = await evaluatePitch(baseParams);
    expect(result.overall_score).toBe(75);
    expect(result.session_id).toBe("s1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("enriches detected_requirements with the description from the resolved framework's requirements, never from the LLM", async () => {
    const resolvedWithRequirements = {
      ...minimalResolved,
      evaluationFramework: {
        ...minimalResolved.evaluationFramework,
        requirements: [
          { id: "mentioned_sas", description: "Menciona SAS de forma natural." },
          { id: "aligned_to_playbook", description: "Alineado con el playbook." },
        ],
      },
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(
                validLlmContent({
                  detected_requirements: [
                    { id: "mentioned_sas", detected: true, evidence: "cita 1" },
                    { id: "aligned_to_playbook", detected: false, evidence: "" },
                  ],
                })
              ),
            },
          },
        ],
      })
    );

    const result = await evaluatePitch({ ...baseParams, resolved: resolvedWithRequirements });

    expect(result.detected_requirements).toEqual([
      { id: "mentioned_sas", detected: true, evidence: "cita 1", description: "Menciona SAS de forma natural." },
      { id: "aligned_to_playbook", detected: false, evidence: "", description: "Alineado con el playbook." },
    ]);
  });

  // Fase 7: an id the model returns that isn't declared by the pinned
  // framework used to be silently accepted with an empty description.
  // Semantic contract validation now rejects it outright — see
  // OPENROUTER_INVALID_EVALUATION_CONTRACT in evaluatorSchema.ts.
  it("rejects a detected_requirements id that isn't declared by the framework (contract violation)", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(
                validLlmContent({
                  detected_requirements: [{ id: "unexpected_id", detected: true, evidence: "x" }],
                })
              ),
            },
          },
        ],
      })
    );

    let caught: unknown;
    try {
      await evaluatePitch(baseParams); // minimalResolved has requirements: []
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvaluationError);
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe(
      "OPENROUTER_INVALID_EVALUATION_CONTRACT"
    );
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

  // Fase 7: runtime schema validation (evaluatorSchema.ts).
  it("classifies a shape-valid JSON that fails the response schema as OPENROUTER_INVALID_RESPONSE_SCHEMA, and does NOT retry", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ overall_score: 80 }) } }],
      })
    );

    let caught: unknown;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvaluationError);
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe(
      "OPENROUTER_INVALID_RESPONSE_SCHEMA"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Fase 7: semantic contract validation (evaluatorSchema.ts) against the
  // PINNED EvaluationFramework — an unknown criterion_id is rejected, not
  // silently dropped or averaged in.
  it("classifies an unknown criterion_id as OPENROUTER_INVALID_EVALUATION_CONTRACT, and does NOT retry", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(
                validLlmContent({
                  criteria_scores: [
                    {
                      criterion_id: "not_in_framework",
                      criterion_name: "?",
                      score: 10,
                      max_score: 100,
                      evidence: "e",
                      comment: "c",
                      recommendation: "r",
                    },
                  ],
                })
              ),
            },
          },
        ],
      })
    );

    let caught: unknown;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EvaluationError);
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe(
      "OPENROUTER_INVALID_EVALUATION_CONTRACT"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a criterion max_score that doesn't match the framework's weight as OPENROUTER_INVALID_EVALUATION_CONTRACT", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(
                validLlmContent({
                  criteria_scores: [
                    {
                      criterion_id: "a",
                      criterion_name: "A",
                      score: 10,
                      max_score: 50, // framework's criterion "a" has weight 100
                      evidence: "e",
                      comment: "c",
                      recommendation: "r",
                    },
                  ],
                })
              ),
            },
          },
        ],
      })
    );

    let caught: unknown;
    try {
      await evaluatePitch(baseParams);
    } catch (err) {
      caught = err;
    }
    expect((caught as InstanceType<typeof EvaluationError>).category).toBe(
      "OPENROUTER_INVALID_EVALUATION_CONTRACT"
    );
  });

  // Fase 7: structured logging (observability/log.ts).
  it("logs an openrouter_attempt event with outcome success and a duration_ms", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okOpenRouterResponse(75));
    await evaluatePitch(baseParams);

    const attemptLog = logEvent.mock.calls
      .map((call) => call[0])
      .find((f) => f.event === "openrouter_attempt");
    expect(attemptLog).toMatchObject({
      provider: "openrouter",
      outcome: "success",
      session_id: "s1",
      attempt: 1,
    });
    expect(typeof attemptLog.duration_ms).toBe("number");
  });

  it("logs an openrouter_attempt event with outcome failure and the safe error_category on a 503, once per attempt", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, false, 503))
      .mockResolvedValueOnce(okOpenRouterResponse(90));
    await evaluatePitch(baseParams);

    const attemptLogs = logEvent.mock.calls.map((call) => call[0]).filter((f) => f.event === "openrouter_attempt");
    expect(attemptLogs).toHaveLength(2);
    expect(attemptLogs[0]).toMatchObject({ outcome: "failure", error_category: "OPENROUTER_5XX", attempt: 1 });
    expect(attemptLogs[1]).toMatchObject({ outcome: "success", attempt: 2 });
  });

  it("logs an evaluation_total event with the overall duration_ms after a successful evaluation", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okOpenRouterResponse(75));
    await evaluatePitch(baseParams);

    const totalLog = logEvent.mock.calls.map((call) => call[0]).find((f) => f.event === "evaluation_total");
    expect(totalLog).toMatchObject({ session_id: "s1", outcome: "success" });
    expect(typeof totalLog.duration_ms).toBe("number");
  });

  // Fase 8 — ERROR_CORRELATION: an optional requestId threads into every
  // log line for this evaluation, so a provider failure can be traced
  // back to the exact HTTP request that triggered it.
  it("includes request_id in openrouter_attempt/evaluation_total logs when provided", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okOpenRouterResponse(75));
    await evaluatePitch({ ...baseParams, requestId: "req-abc" });

    for (const call of logEvent.mock.calls) {
      expect(call[0]).toMatchObject({ request_id: "req-abc" });
    }
  });

  it("omits request_id entirely when not provided (doesn't log it as undefined)", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(okOpenRouterResponse(75));
    await evaluatePitch(baseParams);

    for (const call of logEvent.mock.calls) {
      expect("request_id" in call[0]).toBe(false);
    }
  });
});
