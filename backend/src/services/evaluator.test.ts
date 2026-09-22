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

vi.mock("../data/evaluatorPrompt.js", () => ({
  EVALUATOR_SYSTEM_PROMPT: "system prompt",
  buildEvaluatorUserMessage: () => "user message",
}));

const { evaluatePitch } = await import("./evaluator.js");

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

const baseParams = {
  sessionId: "s1",
  target: "generic" as const,
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
    mentioned_sas: true,
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
