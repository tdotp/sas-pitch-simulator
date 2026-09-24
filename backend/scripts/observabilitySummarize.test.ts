// Fase 8 — OBSERVABILITY_SUMMARIZER. Pure, offline JSON-lines aggregator —
// no network, no storage, reads whatever text it's given. The CLI wrapper
// (observability-summarize.ts) is a thin stdin/file reader around this.
import { describe, it, expect } from "vitest";
import { summarize } from "./observabilitySummarize.js";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("summarize", () => {
  it("counts total requests, successes and errors from http_request events", () => {
    const lines = [
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success", duration_ms: 5 }),
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success", duration_ms: 7 }),
      line({ event: "http_request", endpoint: "/session/start", status_code: 502, outcome: "failure", duration_ms: 40 }),
    ];
    const result = summarize(lines);

    expect(result.request_count).toBe(3);
    expect(result.success_count).toBe(2);
    expect(result.error_count).toBe(1);
    expect(result.error_rate).toBeCloseTo(1 / 3, 5);
  });

  it("groups requests by endpoint", () => {
    const lines = [
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success" }),
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success" }),
      line({ event: "http_request", endpoint: "/session/start", status_code: 200, outcome: "success" }),
    ];
    const result = summarize(lines);
    expect(result.requests_by_endpoint).toEqual({ "/me": 2, "/session/start": 1 });
  });

  it("counts rate_limit_rejected events", () => {
    const lines = [
      line({ event: "rate_limit_rejected", endpoint: "/session/start", rate_limit_scope: "user" }),
      line({ event: "rate_limit_rejected", endpoint: "/session/start", rate_limit_scope: "organization" }),
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success" }),
    ];
    const result = summarize(lines);
    expect(result.rate_limited_count).toBe(2);
  });

  it("counts provider failures and groups them by error_category", () => {
    const lines = [
      line({ event: "openrouter_attempt", provider: "openrouter", outcome: "failure", error_category: "OPENROUTER_TIMEOUT" }),
      line({ event: "openrouter_attempt", provider: "openrouter", outcome: "success" }),
      line({ event: "elevenlabs_signed_url", provider: "elevenlabs", outcome: "failure", error_category: "ELEVENLABS_5XX" }),
      line({ event: "openrouter_attempt", provider: "openrouter", outcome: "failure", error_category: "OPENROUTER_TIMEOUT" }),
    ];
    const result = summarize(lines);
    expect(result.provider_failure_count).toBe(3);
    expect(result.error_count_by_category).toEqual({ OPENROUTER_TIMEOUT: 2, ELEVENLABS_5XX: 1 });
  });

  it("counts evaluation success/failure from evaluation_total events", () => {
    const lines = [
      line({ event: "evaluation_total", provider: "openrouter", outcome: "success" }),
      line({ event: "evaluation_total", provider: "openrouter", outcome: "success" }),
      line({ event: "evaluation_total", provider: "openrouter", outcome: "failure", error_category: "OPENROUTER_5XX" }),
    ];
    const result = summarize(lines);
    expect(result.evaluations).toEqual({ success: 2, failure: 1 });
  });

  // PASS_WITH_FIXES P1.2: nearest-rank is rank = ceil(p * n), 1-indexed,
  // converted to a 0-indexed array position (rank - 1) — NOT
  // floor(p * (n - 1)), which the report claimed to use but didn't. For
  // n=10, p95: ceil(0.95 * 10) = 10 -> index 9 -> the LAST (highest)
  // value, not the 9th of 10.
  it("computes p50/p95/max latency per endpoint using nearest-rank", () => {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const lines = durations.map((d) =>
      line({ event: "http_request", endpoint: "/session/end", status_code: 200, outcome: "success", duration_ms: d })
    );
    const result = summarize(lines);
    const stats = result.latency_by_endpoint["/session/end"];
    expect(stats.count).toBe(10);
    expect(stats.max).toBe(100);
    // nearest-rank, n=10: p50 -> rank ceil(5)=5 -> index 4 -> 50; p95 -> rank ceil(9.5)=10 -> index 9 -> 100
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(100);
  });

  it("nearest-rank with a single value returns that value for every percentile", () => {
    const lines = [line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success", duration_ms: 42 })];
    const result = summarize(lines);
    const stats = result.latency_by_endpoint["/me"];
    expect(stats.p50).toBe(42);
    expect(stats.p95).toBe(42);
    expect(stats.max).toBe(42);
  });

  it("nearest-rank with two values: documents the exact rank chosen for p50 and p95", () => {
    const lines = [10, 20].map((d) =>
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success", duration_ms: d })
    );
    const result = summarize(lines);
    const stats = result.latency_by_endpoint["/me"];
    // n=2: p50 -> rank ceil(1)=1 -> index 0 -> 10; p95 -> rank ceil(1.9)=2 -> index 1 -> 20
    expect(stats.p50).toBe(10);
    expect(stats.p95).toBe(20);
    expect(stats.max).toBe(20);
  });

  it("computes latency per provider and per event independently", () => {
    const lines = [
      line({ event: "openrouter_attempt", provider: "openrouter", outcome: "success", duration_ms: 1000 }),
      line({ event: "elevenlabs_signed_url", provider: "elevenlabs", outcome: "success", duration_ms: 200 }),
    ];
    const result = summarize(lines);
    expect(result.latency_by_provider.openrouter.max).toBe(1000);
    expect(result.latency_by_provider.elevenlabs.max).toBe(200);
    expect(result.latency_by_event.openrouter_attempt.max).toBe(1000);
  });

  it("aggregates organization-level traffic from http_request events", () => {
    const lines = [
      line({ event: "http_request", endpoint: "/me", organization_id: "org-1", status_code: 200, outcome: "success" }),
      line({ event: "http_request", endpoint: "/me", organization_id: "org-1", status_code: 200, outcome: "success" }),
      line({ event: "http_request", endpoint: "/me", organization_id: "org-2", status_code: 200, outcome: "success" }),
      line({ event: "http_request", endpoint: "/health", status_code: 200, outcome: "success" }), // no org — pre-auth
    ];
    const result = summarize(lines);
    expect(result.organization_traffic).toEqual({ "org-1": 2, "org-2": 1 });
  });

  it("handles malformed JSON lines safely without crashing, and counts them", () => {
    const lines = [
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success" }),
      "not valid json {{{",
      "",
      "   ",
      line({ event: "http_request", endpoint: "/me", status_code: 200, outcome: "success" }),
    ];
    expect(() => summarize(lines)).not.toThrow();
    const result = summarize(lines);
    expect(result.request_count).toBe(2);
    expect(result.malformed_lines).toBe(1); // blank lines are skipped silently, not counted as malformed
  });

  it("does not crash on an event missing most fields (only `event` present)", () => {
    const lines = [line({ event: "http_request" }), line({ event: "openrouter_attempt" })];
    expect(() => summarize(lines)).not.toThrow();
    const result = summarize(lines);
    expect(result.request_count).toBe(1);
  });

  // PASS_WITH_FIXES P2: an http_request with no `outcome` field used to
  // fall into the `else` branch of `outcome === "failure" ? error :
  // success`, silently counting as a success. It must count as neither.
  it("an http_request with no outcome field counts toward request_count but NOT success_count or error_count", () => {
    const lines = [line({ event: "http_request", endpoint: "/me" })];
    const result = summarize(lines);
    expect(result.request_count).toBe(1);
    expect(result.success_count).toBe(0);
    expect(result.error_count).toBe(0);
  });

  it("an http_request with an unrecognized outcome value (neither success nor failure) is also neither", () => {
    const lines = [line({ event: "http_request", endpoint: "/me", outcome: "retry" })];
    const result = summarize(lines);
    expect(result.request_count).toBe(1);
    expect(result.success_count).toBe(0);
    expect(result.error_count).toBe(0);
  });

  it("does not crash on a line that's valid JSON but not an object (e.g. a bare number or array)", () => {
    const lines = ["42", "[1,2,3]", '"just a string"'];
    expect(() => summarize(lines)).not.toThrow();
    const result = summarize(lines);
    expect(result.malformed_lines).toBe(3);
  });

  it("returns zeroed-out stats for an empty input, never NaN/undefined", () => {
    const result = summarize([]);
    expect(result.request_count).toBe(0);
    expect(result.error_rate).toBe(0);
    expect(result.latency_by_endpoint).toEqual({});
  });
});
