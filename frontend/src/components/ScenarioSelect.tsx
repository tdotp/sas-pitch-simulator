import { useState } from "react";
import { TARGETS, type TargetId } from "../config";
import type { VoiceGender } from "../types";

export function ScenarioSelect({
  onStart,
  starting,
  error,
}: {
  onStart: (target: TargetId, voice: VoiceGender) => void;
  starting: boolean;
  error?: string;
}) {
  const [selected, setSelected] = useState<TargetId>("generic");
  const [voice, setVoice] = useState<VoiceGender>("random");

  const current = TARGETS.find((t) => t.id === selected)!;

  return (
    <div className="card">
      <h1>Elige tu escenario de práctica</h1>
      <p className="muted">
        Vas a entregar un pitch ejecutivo de 90 segundos (ideal) a máximo 3
        minutos. Incluye una cifra, menciona SAS y cierra con un siguiente paso.
      </p>

      <div className="scenario-grid">
        {TARGETS.map((t) => (
          <button
            key={t.id}
            className={`scenario ${selected === t.id ? "selected" : ""}`}
            style={
              { "--accent": t.accent } as React.CSSProperties & {
                "--accent": string;
              }
            }
            onClick={() => setSelected(t.id)}
            type="button"
          >
            <span className="dot" />
            <h3>{t.label}</h3>
            <p>{t.subtitle}</p>
          </button>
        ))}
      </div>

      {current.allowsVoiceChoice && (
        <>
          <h2>Voz del interlocutor</h2>
          <div className="voice-row">
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
        </>
      )}

      <div className="actions">
        <button
          className="btn btn-primary"
          style={{ width: "auto", paddingInline: 32 }}
          disabled={starting}
          onClick={() => onStart(selected, voice)}
        >
          {starting ? "Conectando…" : "Iniciar práctica"}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Necesitas permitir el micrófono.
        </span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
