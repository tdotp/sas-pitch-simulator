// PASS_WITH_FIXES P1.1: the pre-auth IP safety cap must be a genuine
// SAFETY CEILING, never the layer that actually enforces per-tenant
// fairness — that's what the user/organization limiters are for. This is
// exactly the invariant that broke before the fix (IP cap at 20/min was
// LOWER than /session/start's organization limit of 30/min, making the
// IP layer the real bottleneck). Tested against the REAL, unmocked
// default config (routes.test.ts's dedicated rate-limit tests use a
// generous MOCKED config for isolation, which wouldn't catch a
// regression in the actual shipped defaults).
import { describe, it, expect } from "vitest";
import { config } from "./config.js";

describe("Fase 8 PASS_WITH_FIXES P1.1: ipSafetyCap must not dominate tenant-aware limits", () => {
  it("the IP safety cap is greater than every per-endpoint organization limit", () => {
    expect(config.rateLimits.ipSafetyCap.limit).toBeGreaterThan(config.rateLimits.sessionStart.organization.limit);
    expect(config.rateLimits.ipSafetyCap.limit).toBeGreaterThan(config.rateLimits.sessionEnd.organization.limit);
  });

  it("the IP safety cap is greater than every per-endpoint user limit", () => {
    expect(config.rateLimits.ipSafetyCap.limit).toBeGreaterThan(config.rateLimits.sessionStart.user.limit);
    expect(config.rateLimits.ipSafetyCap.limit).toBeGreaterThan(config.rateLimits.sessionEnd.user.limit);
    expect(config.rateLimits.ipSafetyCap.limit).toBeGreaterThan(config.rateLimits.metricsAnalyze.user.limit);
  });
});
