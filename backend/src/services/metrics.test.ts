// Proves services/metrics.ts is a generic, deterministic speech-metrics
// engine with zero SAS/client awareness — the concrete evidence for
// PHASE_05_FIXES_ADDENDUM item 1 in PHASE_05_ENGINE_CONFIG_REPORT.md.
import { describe, it, expect } from "vitest";
import { computeMetrics } from "./metrics.js";
import type { TranscriptTurn } from "../types.js";

function turns(...texts: string[]): TranscriptTurn[] {
  return texts.map((text) => ({ role: "user" as const, text }));
}

describe("computeMetrics — generic, no client awareness", () => {
  it("never returns a mentioned_sas key, regardless of transcript content", () => {
    const withSas = computeMetrics(turns("Hoy quiero hablar de SAS y de su plataforma."), 30);
    const withoutSas = computeMetrics(turns("Hoy quiero hablar de la plataforma."), 30);
    expect(withSas).not.toHaveProperty("mentioned_sas");
    expect(withoutSas).not.toHaveProperty("mentioned_sas");
  });

  it("returns the exact same key set whether or not the transcript mentions SAS", () => {
    const withSas = computeMetrics(turns("SAS SAS SAS es una empresa."), 30);
    const withoutSas = computeMetrics(turns("Acme es una empresa."), 30);
    expect(Object.keys(withSas).sort()).toEqual(Object.keys(withoutSas).sort());
  });

  it("keeps the generic deterministic signals: word count, WPM, fillers, repetitions, numbers, CTA, pauses", () => {
    const result = computeMetrics(
      turns("Eh, propongo un siguiente paso: un piloto de 30 días con un ahorro del 20%."),
      30
    );
    expect(result.word_count).toBeGreaterThan(0);
    expect(result.words_per_minute).toBeGreaterThan(0);
    expect(result.filler_words_total).toBeGreaterThanOrEqual(1);
    expect(result.repetition_count).toBe(0);
    expect(result.used_numbers).toBe(true);
    expect(result.numbers_detected.length).toBeGreaterThan(0);
    expect(result.has_cta).toBe(true);
    expect(result.long_pauses_count).toBe(0);
  });

  it("computes has_cta/used_numbers identically for content naming a different client entirely", () => {
    const acme = computeMetrics(
      turns("Propongo un siguiente paso con Acme Demo Co: un ahorro del 15%."),
      30
    );
    expect(acme.has_cta).toBe(true);
    expect(acme.used_numbers).toBe(true);
  });
});
