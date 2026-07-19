import type { EvaluationResult, SpeechMetrics } from "../types";

function readinessColor(level: string): string {
  switch (level) {
    case "sobresaliente":
      return "#1f9d55";
    case "alto":
      return "#3fa34d";
    case "medio":
      return "#d98a00";
    default:
      return "#e4002b";
  }
}

const todayLabel = new Date()
  .toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })
  .toUpperCase()
  .replace(".", "");

export function Report({
  evaluation,
  metrics,
  targetLabel,
  onRetry,
  onAnalysis,
}: {
  evaluation: EvaluationResult;
  metrics: SpeechMetrics;
  targetLabel: string;
  onRetry: () => void;
  onAnalysis: () => void;
}) {
  const e = evaluation;
  const strength = e.strengths[0];
  const opportunity = e.improvement_areas[0];
  const nextStep = e.next_training_focus[0] ?? e.improvement_areas[1];

  return (
    <section className="screen screen--report">
      <header className="report-header">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
        <span className="report-meta">SmartPR / Simulador de vocería</span>
        <span className="report-meta report-meta--right">
          {targetLabel} · {todayLabel}
        </span>
      </header>

      <div className="report-body">
        <div className="report-grid">
          <div className="report-main">
            <h1>{e.one_line_diagnosis}</h1>

            <div className="report-badges">
              <span
                className="readiness"
                style={{
                  background: `${readinessColor(e.readiness_level)}22`,
                  color: readinessColor(e.readiness_level),
                }}
              >
                {e.overall_score} / 100 · Nivel {e.readiness_level}
              </span>
              <span className="muted">Target: {targetLabel}</span>
              <span className="muted">Duración: {e.duration.formatted}</span>
            </div>

            <div className="report-summary">
              <h2>Resumen</h2>
              <p>{e.executive_summary}</p>
            </div>
          </div>

          <aside className="metrics-list" aria-label="Métricas">
            <div>
              <strong>{e.duration.formatted}</strong>
              <span>duración</span>
            </div>
            <div>
              <strong>{metrics.words_per_minute}</strong>
              <span>palabras/minuto</span>
            </div>
            <div>
              <strong>{metrics.numbers_detected.length}</strong>
              <span>cifras utilizadas</span>
            </div>
            <div>
              <strong>{metrics.has_cta ? "Sí" : "No"}</strong>
              <span>llamado a la acción</span>
            </div>
          </aside>
        </div>

        <div className="insight-grid">
          {strength && (
            <article className="insight-card">
              <span className="insight-icon">☆</span>
              <div>
                <h3>Fortaleza</h3>
                <p>{strength}</p>
              </div>
            </article>
          )}
          {opportunity && (
            <article className="insight-card">
              <span className="insight-icon">↗</span>
              <div>
                <h3>Oportunidad</h3>
                <p>{opportunity}</p>
              </div>
            </article>
          )}
          {nextStep && (
            <article className="insight-card">
              <span className="insight-icon">⚑</span>
              <div>
                <h3>Próximo intento</h3>
                <p>{nextStep}</p>
              </div>
            </article>
          )}
        </div>

        <footer className="report-actions">
          <button
            className="text-button text-button--left"
            type="button"
            onClick={onRetry}
          >
            ↻ Repetir escenario
          </button>
          <button
            className="primary-button report-next"
            type="button"
            onClick={onAnalysis}
          >
            Ver análisis completo <span>→</span>
          </button>
        </footer>
      </div>
    </section>
  );
}
