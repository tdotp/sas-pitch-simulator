import type { EvaluationResult, SpeechMetrics } from "../types";

function Check({ ok }: { ok: boolean | "partial" }) {
  if (ok === "partial") return <span className="check-partial">◐</span>;
  return ok ? (
    <span className="check-yes">✓</span>
  ) : (
    <span className="check-no">✗</span>
  );
}

export function Analysis({
  evaluation,
  metrics,
  targetLabel,
  onRestart,
  onContinue,
}: {
  evaluation: EvaluationResult;
  metrics: SpeechMetrics;
  targetLabel: string;
  onRestart: () => void;
  onContinue: () => void;
}) {
  const e = evaluation;
  const durationOk =
    e.duration.status === "ideal"
      ? true
      : e.duration.status === "fuera_de_rango"
        ? false
        : "partial";

  return (
    <section className="screen screen--analysis">
      <header className="analysis-topline">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
        <span className="report-meta">SmartPR / Simulador de vocería</span>
        <span className="report-meta report-meta--right">
          {targetLabel} · Análisis completo
        </span>
      </header>

      <div className="analysis-page">
        <h1>Análisis de la sesión</h1>

        {/* Requisitos mínimos */}
        <h2 className="analysis-section-title">Requisitos mínimos</h2>
        <ul className="checklist">
          <li>
            <Check ok={durationOk} /> Duración ({e.duration.formatted})
          </li>
          {/* Señales deterministas y genéricas: vienen de metrics/
              speech_metrics, nunca de detected_requirements. */}
          <li>
            <Check ok={metrics.used_numbers} /> Incluyó cifra
          </li>
          <li>
            <Check ok={metrics.has_cta} /> Call to action
          </li>
          {/* Requirements definidos por el framework de este cliente —
              renderizados dinámicamente, sin ids hardcodeados. Un cliente
              nuevo con requirements distintos no necesita ningún cambio
              aquí. */}
          {e.detected_requirements.map((r) => (
            <li key={r.id}>
              <Check ok={r.detected} />
              <span>
                {r.description}
                {r.evidence && <span className="req-evidence">{r.evidence}</span>}
              </span>
            </li>
          ))}
        </ul>

        {/* Métricas de habla */}
        <h2 className="analysis-section-title">Métricas de habla</h2>
        <div className="metric-grid">
          <div className="metric-tile">
            <div className="val">{metrics.word_count}</div>
            <div className="lbl">Palabras</div>
          </div>
          <div className="metric-tile">
            <div className="val">{metrics.words_per_minute}</div>
            <div className="lbl">Palabras / min</div>
          </div>
          <div className="metric-tile">
            <div className="val">{metrics.filler_words_total}</div>
            <div className="lbl">Muletillas</div>
          </div>
          <div className="metric-tile">
            <div className="val">{metrics.repetition_count}</div>
            <div className="lbl">Repeticiones</div>
          </div>
          <div className="metric-tile">
            <div className="val">{metrics.numbers_detected.length}</div>
            <div className="lbl">Cifras detectadas</div>
          </div>
        </div>
        {e.speech_metrics.comment && (
          <p className="metric-comment">{e.speech_metrics.comment}</p>
        )}

        {/* Puntaje por criterio */}
        <h2 className="analysis-section-title">Puntaje por criterio</h2>
        {e.criteria_scores.map((c) => (
          <div className="criteria-bar" key={c.criterion_id}>
            <div className="head">
              <span>{c.criterion_name}</span>
              <b>
                {c.score}/{c.max_score}
              </b>
            </div>
            <div className="track">
              <div
                className="fill"
                style={{
                  width: `${c.max_score ? (c.score / c.max_score) * 100 : 0}%`,
                }}
              />
            </div>
            {c.comment && <div className="cmt">{c.comment}</div>}
          </div>
        ))}

        {/* Alertas críticas */}
        {e.critical_flags.length > 0 && (
          <>
            <h2 className="analysis-section-title">Alertas críticas</h2>
            {e.critical_flags.map((f, i) => (
              <div className="flag" key={i}>
                <b>{f.flag}</b> — {f.comment}
              </div>
            ))}
          </>
        )}

        {/* Fortalezas / Mejoras */}
        <div className="two-col">
          <div>
            <h2 className="analysis-section-title">Fortalezas</h2>
            <ul className="pill-list">
              {e.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="analysis-section-title">Áreas de mejora</h2>
            <ul className="pill-list">
              {e.improvement_areas.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* Frases destacadas */}
        {(e.best_line_from_user || e.weakest_line_from_user) && (
          <>
            <h2 className="analysis-section-title">Frases destacadas</h2>
            {e.best_line_from_user && (
              <p className="quote-line">
                <span className="check-yes">Mejor:</span> “{e.best_line_from_user}”
              </p>
            )}
            {e.weakest_line_from_user && (
              <p className="quote-line">
                <span className="check-no">A revisar:</span> “
                {e.weakest_line_from_user}”
              </p>
            )}
          </>
        )}

        {/* Recomendaciones */}
        {e.next_training_focus.length > 0 && (
          <>
            <h2 className="analysis-section-title">Recomendaciones</h2>
            <div className="recommendations">
              {e.next_training_focus.map((r, i) => (
                <article key={i}>
                  <strong>{String(i + 1).padStart(2, "0")}</strong>
                  <div>
                    <p>{r}</p>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

        {/* Pitch sugerido */}
        <h2 className="analysis-section-title">Versión sugerida · 90 segundos</h2>
        <div className="pitch-box">{e.recommended_pitch_90_seconds}</div>

        <h2 className="analysis-section-title">Versión ultra corta · 45 segundos</h2>
        <div className="pitch-box">{e.recommended_pitch_45_seconds}</div>

        <h2 className="analysis-section-title">Call to action recomendado</h2>
        <div className="pitch-box">{e.recommended_cta}</div>

        {/* Coach feedback */}
        {e.coach_feedback && (
          <>
            <h2 className="analysis-section-title">Feedback del coach</h2>
            <p className="quote-line">{e.coach_feedback}</p>
          </>
        )}

        <footer className="analysis-actions">
          <button
            className="text-button text-button--left"
            type="button"
            onClick={onRestart}
          >
            ↻ Volver a iniciar
          </button>
          <button
            className="primary-button analysis-continue"
            type="button"
            onClick={onContinue}
          >
            Continuar con {targetLabel} <span>→</span>
          </button>
        </footer>
      </div>
    </section>
  );
}
