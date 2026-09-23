// PASS_WITH_FIXES (Phase 5, 2nd round): proves the Analysis panel renders
// detected_requirements dynamically from the array the backend sends —
// no hardcoded ids (mentioned_sas/aligned_to_playbook/verifiable_data),
// and used_numbers/has_cta come from metrics, never from
// detected_requirements. Uses react-dom/server's renderToStaticMarkup
// (already a transitive dependency of react-dom) instead of adding a
// jsdom + Testing Library stack for a couple of read-only report screens.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Analysis } from "./Analysis";
import type { EvaluationResult, SpeechMetrics } from "../types";

function baseMetrics(overrides: Partial<SpeechMetrics> = {}): SpeechMetrics {
  return {
    word_count: 50,
    words_per_minute: 120,
    filler_words_total: 2,
    filler_words_items: {},
    repetition_count: 0,
    repetition_items: [],
    long_pauses_count: 0,
    used_numbers: true,
    numbers_detected: ["20%"],
    has_cta: true,
    ...overrides,
  };
}

function baseEvaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    session_id: "s1",
    target_mode: "generic",
    overall_score: 80,
    readiness_level: "alto",
    one_line_diagnosis: "diag",
    executive_summary: "summary",
    duration: {
      seconds: 90,
      formatted: "1:30",
      ideal_seconds: 90,
      max_seconds: 180,
      status: "ideal",
      comment: "",
    },
    detected_requirements: [],
    speech_metrics: {
      word_count: 50,
      words_per_minute: 120,
      filler_words_total: 2,
      top_filler_words: [],
      repetition_count: 0,
      top_repetitions: [],
      long_pauses_count: 0,
      used_numbers: true,
      numbers_detected: ["20%"],
      has_cta: true,
      comment: "",
    },
    criteria_scores: [],
    strengths: [],
    improvement_areas: [],
    critical_flags: [],
    missed_opportunities: [],
    best_line_from_user: "",
    weakest_line_from_user: "",
    recommended_pitch_90_seconds: "",
    recommended_pitch_45_seconds: "",
    recommended_cta: "",
    next_training_focus: [],
    coach_feedback: "",
    ...overrides,
  };
}

const noop = () => {};

function renderAnalysis(evaluation: EvaluationResult, metrics: SpeechMetrics): string {
  return renderToStaticMarkup(
    <Analysis
      evaluation={evaluation}
      metrics={metrics}
      targetLabel="Target"
      onRestart={noop}
      onContinue={noop}
    />
  );
}

// Finds the check-yes/check-no/check-partial class closest before `label`
// in the rendered HTML — each checklist <li> puts the mark right before
// its text.
function checkStateFor(html: string, label: string): "yes" | "no" | "partial" | null {
  const idx = html.indexOf(label);
  if (idx === -1) return null;
  const window = html.slice(Math.max(0, idx - 200), idx);
  const matches = [...window.matchAll(/check-(yes|no|partial)/g)];
  const last = matches[matches.length - 1];
  return (last?.[1] as "yes" | "no" | "partial" | undefined) ?? null;
}

describe("Analysis — dynamic detected_requirements checklist", () => {
  it("renders SAS's requirements only because they arrived in the data, with no hardcoded id branch", () => {
    const evaluation = baseEvaluation({
      detected_requirements: [
        { id: "mentioned_sas", description: "Mencionó SAS de forma natural", detected: true, evidence: "cita textual" },
        { id: "aligned_to_playbook", description: "Alineación al playbook", detected: false, evidence: "" },
      ],
    });
    const html = renderAnalysis(evaluation, baseMetrics());
    expect(html).toContain("Mencionó SAS de forma natural");
    expect(html).toContain("Alineación al playbook");
    expect(html).toContain("cita textual");
    expect(checkStateFor(html, "Mencionó SAS de forma natural")).toBe("yes");
    expect(checkStateFor(html, "Alineación al playbook")).toBe("no");
  });

  it("renders a fictitious framework's requirement (verifiable_data) with the exact same code path, no client-specific branch", () => {
    const evaluation = baseEvaluation({
      detected_requirements: [
        { id: "verifiable_data", description: "Incluye un dato verificable", detected: true, evidence: "20%" },
      ],
    });
    const html = renderAnalysis(evaluation, baseMetrics());
    expect(html).toContain("Incluye un dato verificable");
    expect(checkStateFor(html, "Incluye un dato verificable")).toBe("yes");
  });

  it("never reads req.mentioned_sas / req.aligned_to_playbook as fixed object keys — an empty array renders cleanly", () => {
    const evaluation = baseEvaluation({ detected_requirements: [] });
    expect(() => renderAnalysis(evaluation, baseMetrics())).not.toThrow();
    const html = renderAnalysis(evaluation, baseMetrics());
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Mencionó SAS");
  });

  it("used_numbers and has_cta reflect metrics, independent of detected_requirements", () => {
    const evaluation = baseEvaluation({ detected_requirements: [] });

    const htmlPositive = renderAnalysis(evaluation, baseMetrics({ used_numbers: true, has_cta: true }));
    expect(checkStateFor(htmlPositive, "Incluyó cifra")).toBe("yes");
    expect(checkStateFor(htmlPositive, "Call to action")).toBe("yes");

    const htmlNegative = renderAnalysis(evaluation, baseMetrics({ used_numbers: false, has_cta: false }));
    expect(checkStateFor(htmlNegative, "Incluyó cifra")).toBe("no");
    expect(checkStateFor(htmlNegative, "Call to action")).toBe("no");
  });
});
