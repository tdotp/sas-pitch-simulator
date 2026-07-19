import { Orb } from "./Orb";

export function Preparation({
  ready,
  starting,
  error,
  onStart,
  onBack,
}: {
  ready: boolean;
  starting: boolean;
  error?: string;
  onStart: () => void;
  onBack: () => void;
}) {
  return (
    <section className="screen screen--preparation">
      <header className="brand-header">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
      </header>

      <div className="preparation-content">
        <p className="eyebrow">Antes de comenzar</p>
        <h1 className="display-title display-title--prep">
          Tienes hasta
          <br />
          tres minutos.
        </h1>
        <p className="lead prep-lead">
          Presenta el problema, explica el valor de SAS
          <br />y cierra con un siguiente paso claro.
        </p>

        <div className="session-stats">
          <div>
            <span>Duración ideal</span>
            <strong>
              90 <small>Segundos</small>
            </strong>
          </div>
          <div>
            <span>Tiempo máximo</span>
            <strong>
              3 <small>Minutos</small>
            </strong>
          </div>
          <div>
            <span>Repreguntas</span>
            <strong>1–2</strong>
          </div>
        </div>

        <div className="prep-mobile-flow" aria-label="Estructura sugerida">
          <article>
            <span className="step-icon">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M7 7h18v13H14l-6 5v-5H7z" />
                <path d="M16 11.5v1.2c0 1.2-2 1.4-2 3.2M14 19h.01" />
              </svg>
            </span>
            <div>
              <small>01</small>
              <strong>Problema</strong>
              <p>Presenta el contexto y el reto clave.</p>
            </div>
          </article>
          <article>
            <span className="step-icon">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M6 16 15 7h11v11l-9 9z" />
                <path d="M23 4v6M20 7h6" />
              </svg>
            </span>
            <div>
              <small>02</small>
              <strong>Valor</strong>
              <p>Explica cómo SAS genera impacto.</p>
            </div>
          </article>
          <article>
            <span className="step-icon">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M5 16h21M18 8l8 8-8 8" />
              </svg>
            </span>
            <div>
              <small>03</small>
              <strong>Acción</strong>
              <p>Propón el siguiente paso concreto.</p>
            </div>
          </article>
        </div>

        <div className="preparation-footer mobile-bottom-bar">
          <div className="mic-ready">
            <span className={`status-dot ${ready ? "" : "is-waiting"}`} />
            {ready ? "Micrófono y agente listos" : "Preparando la sesión…"}
          </div>
          <div className="prep-footer-actions">
            <button className="text-button" type="button" onClick={onBack}>
              ‹ Cambiar escenario
            </button>
            <button
              className="primary-button prep-start"
              type="button"
              onClick={onStart}
              disabled={!ready || starting}
            >
              {starting ? "Conectando…" : "Comenzar"} <span>›</span>
            </button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="mobile-bottom-spacer" />
      </div>

      <div className="prep-orb-wrap" aria-hidden="true">
        <Orb variant="light" state="idle" />
      </div>
    </section>
  );
}
