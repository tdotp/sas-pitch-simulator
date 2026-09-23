// Fase 7: structured logging helper. The whitelist of fields in LogFields
// (log.ts) IS the redaction mechanism — an object literal passed to
// logEvent that isn't one of these fields fails TypeScript's excess
// property check at compile time, so there is no separate runtime
// "scrub secrets by key name" pass to get wrong or forget. These tests
// cover the runtime shape (valid JSON, one line, expected fields present).
import { describe, it, expect, vi, afterEach } from "vitest";
import { logEvent } from "./log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logEvent", () => {
  it("logs a single line of valid JSON containing the given fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({ event: "openrouter_attempt", session_id: "s1", provider: "openrouter", outcome: "success" });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("openrouter_attempt");
    expect(parsed.session_id).toBe("s1");
    expect(parsed.provider).toBe("openrouter");
    expect(parsed.outcome).toBe("success");
  });

  it("includes an ISO timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({ event: "test_event" });

    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
    expect(parsed.ts).toBe(new Date(parsed.ts).toISOString());
  });

  it("omits fields that weren't provided rather than logging them as undefined/null", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({ event: "minimal_event" });

    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect("session_id" in parsed).toBe(false);
    expect("error_category" in parsed).toBe(false);
  });
});

describe("elapsedMs", () => {
  it("returns the whole-millisecond difference from a start time", async () => {
    const { elapsedMs } = await import("./log.js");
    const start = Date.now() - 42;
    const elapsed = elapsedMs(start);
    expect(elapsed).toBeGreaterThanOrEqual(42);
    expect(elapsed).toBeLessThan(5000);
  });
});
