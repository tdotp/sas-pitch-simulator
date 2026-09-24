// Fase 9 (Quality Gate) — pure orchestration logic, deliberately
// separated from the CLI wrapper (run-quality-gate.ts) that defines the
// REAL steps (which spawn subprocesses). This split exists so the
// orchestrator's own aggregation/exit-code logic has a fast, hermetic
// self-test (Fase 9 spec item 24) that never spawns a real subprocess —
// mirrors the existing split between staleEvaluatingArgs.ts (pure,
// tested) and mark-stale-evaluating-sessions.ts (CLI wrapper, untested
// by design, see Fase 9 report TEST_ENVIRONMENT_SAFETY).
//
// DECISION (documented per Fase 9 spec item 11): AGGREGATE, not
// fail-fast. Every step always runs, even if an earlier one failed — an
// operator fixing a red gate wants to see every failing block in one
// run, not one at a time across repeated invocations.

export interface QualityGateStep {
  name: string;
  run: () => Promise<{ ok: boolean; output?: string }>;
}

export interface StepResult {
  name: string;
  ok: boolean;
  durationMs: number;
  output?: string;
  error?: string;
}

export interface QualityGateRun {
  results: StepResult[];
  allPassed: boolean;
}

export async function runQualityGateSteps(steps: QualityGateStep[]): Promise<QualityGateRun> {
  const results: StepResult[] = [];

  for (const step of steps) {
    const startedAt = Date.now();
    try {
      const { ok, output } = await step.run();
      results.push({ name: step.name, ok, durationMs: Date.now() - startedAt, output });
    } catch (err) {
      results.push({
        name: step.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { results, allPassed: results.every((r) => r.ok) };
}

export function formatReport(run: QualityGateRun): string {
  const lines = run.results.map((r) => {
    const label = r.ok ? "[PASS]" : "[FAIL]";
    const errorSuffix = r.error ? ` — ${r.error}` : "";
    return `${label} ${r.name} (${r.durationMs}ms)${errorSuffix}`;
  });
  const summary = run.allPassed
    ? `\nQUALITY GATE: PASS (${run.results.length}/${run.results.length} steps)`
    : `\nQUALITY GATE: FAIL (${run.results.filter((r) => r.ok).length}/${run.results.length} steps passed)`;
  return [...lines, summary].join("\n");
}

export function computeExitCode(run: QualityGateRun): number {
  return run.allPassed ? 0 : 1;
}
