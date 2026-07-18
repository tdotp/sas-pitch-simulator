import type { EvaluationResult, SpeechMetrics } from "../types";

function scoreColor(score: number): string {
  if (score >= 90) return "#1f9d55";
  if (score >= 80) return "#3fa34d";
  if (score >= 70) return "#d98a00";
  if (score >= 60) return "#e2711d";
  return "#e4002b";
}

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

function Check({ ok }: { ok: boolean | "partial" }) {
  if (ok === "partial") return <span className="check-partial">◐</span>;
  return ok ? (
    <span className="check-yes">✓</span>
  ) : (
    <span className="check-no">✗</span>
  );
}

export function Report({
  evaluation,
  metrics,
  targetLabel,
  onRetry,
  onHome,
}: {
  evaluation: EvaluationResult;
  metrics: SpeechMetrics;
  targetLabel: string;
  onRetry: () => void;
  onHome: () => void;
}) {
  const e = evaluation;
  const req = e.detected_requirements;

  return (
    <div className="card">
      {/* Hero */}
      <div className="score-hero">
        <div
          className="score-ring"
          style={{ background: scoreColor(e.overall_score) }}
        >
          <div>
            <div className="num">{e.overall_score}</div>
            <div className="den">/ 100</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ marginBottom: 8 }}>Resultado de tu pitch</h1>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span
              className="readiness"
              style={{
                background: `${readinessColor(e.readiness_level)}22`,
                color: readinessColor(e.readiness_level),
              }}
            >
              Nivel: {e.readiness_level}
            </span>
            <span className="muted">Target: {targetLabel}</span>
            <span className="muted">Duración: {e.duration.formatted}</span>
          </div>
          <p style={{ marginTop: 12, fontWeight: 600 }}>{e.one_line_diagnosis}</p>
        </div>
      </div>

      {/* Executive summary */}
      <h2>Resumen ejecutivo</h2>
      <p>{e.executive_summary}</p>

      {/* Checklist */}
      <h2>Requisitos mínimos</h2>
      <ul className="checklist">
        <li>
          <Check
            ok={
              e.duration.status === "ideal"
                ? true
                : e.duration.status === "fuera_de_rango"
                  ? false
                  : "partial"
            }
          />
          Duración ({e.duration.formatted})
        </li>
        <li>
          <Check ok={req.used_numbers} /> Incluyó cifra
        </li>
        <li>
          <Check ok={req.mentioned_sas} /> Mencionó SAS
        </li>
        <li>
          <Check ok={req.has_cta} /> Call to action
        </li>
        <li>
          <Check ok={req.aligned_to_playbook} /> Alineación al playbook
        </li>
      </ul>

      {/* Speech metrics */}
      <h2>Métricas de habla</h2>
      <div className="metric-grid">
        <div className="metric">
          <div className="val">{metrics.word_count}</div>
          <div className="lbl">Palabras</div>
        </div>
        <div className="metric">
          <div className="val">{metrics.words_per_minute}</div>
          <div className="lbl">Palabras / min</div>
        </div>
        <div className="metric">
          <div className="val">{metrics.filler_words_total}</div>
          <div className="lbl">Muletillas</div>
        </div>
        <div className="metric">
          <div className="val">{metrics.repetition_count}</div>
          <div className="lbl">Repeticiones</div>
        </div>
        <div className="metric">
          <div className="val">{metrics.numbers_detected.length}</div>
          <div className="lbl">Cifras detectadas</div>
        </div>
      </div>
      {e.speech_metrics.comment && (
        <p className="muted" style={{ marginTop: 10 }}>
          {e.speech_metrics.comment}
        </p>
      )}

      {/* Criteria */}
      <h2>Puntaje por criterio</h2>
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

      {/* Critical flags */}
      {e.critical_flags.length > 0 && (
        <>
          <h2>Alertas críticas</h2>
          {e.critical_flags.map((f, i) => (
            <div className="flag" key={i}>
              <b>{f.flag}</b> — {f.comment}
            </div>
          ))}
        </>
      )}

      {/* Strengths / improvements */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div>
          <h2>Fortalezas</h2>
          <ul className="pill-list">
            {e.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Áreas de mejora</h2>
          <ul className="pill-list">
            {e.improvement_areas.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Highlighted lines */}
      {(e.best_line_from_user || e.weakest_line_from_user) && (
        <>
          <h2>Frases destacadas</h2>
          {e.best_line_from_user && (
            <p>
              <b className="check-yes">Mejor: </b>“{e.best_line_from_user}”
            </p>
          )}
          {e.weakest_line_from_user && (
            <p>
              <b className="check-no">A revisar: </b>“{e.weakest_line_from_user}”
            </p>
          )}
        </>
      )}

      {/* Recommended pitches */}
      <h2>Versión sugerida · 90 segundos</h2>
      <div className="pitch-box">{e.recommended_pitch_90_seconds}</div>
      <h2>Versión ultra corta · 45 segundos</h2>
      <div className="pitch-box">{e.recommended_pitch_45_seconds}</div>

      <h2>Call to action recomendado</h2>
      <div className="pitch-box">{e.recommended_cta}</div>

      {/* Next focus */}
      {e.next_training_focus.length > 0 && (
        <>
          <h2>Próximo foco de entrenamiento</h2>
          <ul className="pill-list">
            {e.next_training_focus.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {e.coach_feedback && (
        <>
          <h2>Feedback del coach</h2>
          <p>{e.coach_feedback}</p>
        </>
      )}

      <div className="actions">
        <button className="btn btn-primary" style={{ width: "auto", paddingInline: 28 }} onClick={onRetry}>
          Repetir con el mismo target
        </button>
        <button className="btn btn-ghost" onClick={onHome}>
          Elegir otro escenario
        </button>
      </div>
    </div>
  );
}
