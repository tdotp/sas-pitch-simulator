// PASS_WITH_FIXES P1.2: --hours must be validated BEFORE
// mark-stale-evaluating-sessions.ts ever calls initFirebase() — a
// negative value can produce a cutoff in the FUTURE, which would select
// legitimate in-flight `evaluating` sessions. This is a separate, pure
// module (no Firebase import) specifically so it can be unit-tested
// without importing the script itself — the script's `main()` runs
// unconditionally at module load, which would hit real Firebase on
// import (see the incident noted in
// PHASE_07_RELIABILITY_PROVIDER_HARDENING_REPORT.md).
import { describe, it, expect } from "vitest";
import { parseHours } from "./staleEvaluatingArgs.js";

describe("parseHours", () => {
  it("defaults to 2 hours when --hours is not given", () => {
    const result = parseHours(undefined);
    expect(result).toEqual({ ok: true, hours: 2 });
  });

  it("accepts a valid positive value", () => {
    const result = parseHours("6");
    expect(result).toEqual({ ok: true, hours: 6 });
  });

  it("rejects a negative value (would produce a future cutoff)", () => {
    const result = parseHours("-1");
    expect(result.ok).toBe(false);
  });

  it("rejects zero", () => {
    const result = parseHours("0");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric string", () => {
    const result = parseHours("abc");
    expect(result.ok).toBe(false);
  });

  it("rejects Infinity", () => {
    const result = parseHours("Infinity");
    expect(result.ok).toBe(false);
  });

  it("rejects NaN spelled out", () => {
    const result = parseHours("NaN");
    expect(result.ok).toBe(false);
  });

  it("includes the offending raw value in the error message", () => {
    const result = parseHours("-1");
    if (!result.ok) {
      expect(result.error).toContain("-1");
    } else {
      throw new Error("expected rejection");
    }
  });
});
