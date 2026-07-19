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

        <div className="preparation-footer">
          <div className="mic-ready">
            <span className={`status-dot ${ready ? "" : "is-waiting"}`} />
            {ready ? "Micrófono y agente listos" : "Preparando la sesión…"}
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
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
      </div>

      <div className="prep-orb-wrap" aria-hidden="true">
        <Orb variant="light" state="idle" />
      </div>
    </section>
  );
}
