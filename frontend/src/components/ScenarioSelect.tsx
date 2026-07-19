import { useState } from "react";
import { TARGETS, type TargetId } from "../config";
import type { VoiceGender } from "../types";

export function ScenarioSelect({
  onContinue,
  error,
}: {
  onContinue: (target: TargetId, voice: VoiceGender) => void;
  error?: string;
}) {
  const [selected, setSelected] = useState<TargetId>("generic");
  const [voice, setVoice] = useState<VoiceGender>("random");

  const current = TARGETS.find((t) => t.id === selected)!;

  return (
    <section className="screen screen--selection">
      <header className="brand-header">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
      </header>

      <div className="selection-content">
        <p className="eyebrow">Sesión de práctica</p>
        <h1 className="display-title display-title--selection">
          ¿Qué conversación
          <br />
          quieres practicar hoy?
        </h1>
        <p className="lead">
          Selecciona un contexto para simular una conversación ejecutiva
        </p>

        <div className="scenario-list" role="radiogroup" aria-label="Escenario">
          {TARGETS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected === t.id}
              className={`scenario-row ${selected === t.id ? "is-selected" : ""}`}
              onClick={() => setSelected(t.id)}
            >
              <span className="scenario-number">{t.number}</span>
              <span className="scenario-copy">
                <strong>{t.label}</strong>
                <small>{t.subtitle}</small>
              </span>
              <span className="scenario-arrow" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>

        <div className="selection-footer">
          {current.allowsVoiceChoice ? (
            <div className="voice-picker">
              <span className="voice-label">Voz del interlocutor</span>
              {(
                [
                  ["random", "Aleatoria"],
                  ["male", "Hombre"],
                  ["female", "Mujer"],
                ] as [VoiceGender, string][]
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={`chip ${voice === v ? "active" : ""}`}
                  onClick={() => setVoice(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}

          <div className="mobile-bottom-bar">
            <button
              className="primary-button"
              type="button"
              onClick={() => onContinue(selected, voice)}
            >
              Continuar <span>›</span>
            </button>
          </div>
        </div>

        {error && <div className="error-text">{error}</div>}
        <div className="mobile-bottom-spacer" />
      </div>
    </section>
  );
}
