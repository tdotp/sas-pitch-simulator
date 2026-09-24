import { describe, it, expect } from "vitest";
import { runQualityGateSteps, formatReport, computeExitCode, type QualityGateStep } from "./qualityGate.js";

function passingStep(name: string): QualityGateStep {
  return { name, run: async () => ({ ok: true, output: "ok" }) };
}
function failingStep(name: string): QualityGateStep {
  return { name, run: async () => ({ ok: false, output: "boom" }) };
}
function throwingStep(name: string): QualityGateStep {
  return {
    name,
    run: async () => {
      throw new Error("step definition bug");
    },
  };
}

describe("runQualityGateSteps", () => {
  it("QUALITY_GATE_SELF_TEST: all steps passing -> allPassed true, exit 0", async () => {
    const run = await runQualityGateSteps([passingStep("a"), passingStep("b")]);
    expect(run.allPassed).toBe(true);
    expect(computeExitCode(run)).toBe(0);
  });

  it("QUALITY_GATE_SELF_TEST: one failing step -> allPassed false, exit 1", async () => {
    const run = await runQualityGateSteps([passingStep("a"), failingStep("b")]);
    expect(run.allPassed).toBe(false);
    expect(computeExitCode(run)).toBe(1);
  });

  it("AGGREGATE_NOT_FAIL_FAST: a failing step never prevents later steps from running", async () => {
    const run = await runQualityGateSteps([failingStep("a"), passingStep("b")]);
    expect(run.results.map((r) => r.name)).toEqual(["a", "b"]);
    expect(run.results[1].ok).toBe(true);
  });

  it("a step that throws is reported as a failure, not an uncaught exception", async () => {
    const run = await runQualityGateSteps([throwingStep("a"), passingStep("b")]);
    expect(run.allPassed).toBe(false);
    expect(run.results[0].ok).toBe(false);
    expect(run.results[0].error).toContain("step definition bug");
    expect(run.results[1].ok).toBe(true);
  });
});

describe("formatReport", () => {
  it("labels each step [PASS] or [FAIL] and includes an overall summary line", async () => {
    const run = await runQualityGateSteps([passingStep("backend tests"), failingStep("architecture scan")]);
    const report = formatReport(run);
    expect(report).toContain("[PASS] backend tests");
    expect(report).toContain("[FAIL] architecture scan");
    expect(report).toContain("QUALITY GATE: FAIL (1/2 steps passed)");
  });
});
