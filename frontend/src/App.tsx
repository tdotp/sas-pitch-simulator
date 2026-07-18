import { useEffect, useState } from "react";
import { Login } from "./components/Login";
import { ScenarioSelect } from "./components/ScenarioSelect";
import { PracticeSession } from "./components/PracticeSession";
import { Report } from "./components/Report";
import { startSession, endSession, health } from "./api";
import { TARGETS, type TargetId } from "./config";
import type {
  EvaluationResult,
  SpeechMetrics,
  StartSessionResponse,
  TranscriptTurn,
  VoiceGender,
} from "./types";

type Stage = "login" | "select" | "session" | "evaluating" | "report" | "error";

export default function App() {
  const [stage, setStage] = useState<Stage>("login");
  const [session, setSession] = useState<StartSessionResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [evalError, setEvalError] = useState("");
  const [result, setResult] = useState<{
    evaluation: EvaluationResult;
    metrics: SpeechMetrics;
    targetLabel: string;
  } | null>(null);
  const [lastTarget, setLastTarget] = useState<TargetId>("generic");
  const [lastVoice, setLastVoice] = useState<VoiceGender>("random");
  const [envWarning, setEnvWarning] = useState("");

  useEffect(() => {
    if (stage !== "select") return;
    health()
      .then((h) => {
        if (!h.eleven_ready || !h.openrouter_ready) {
          const missing = [
            !h.eleven_ready ? "ElevenLabs" : null,
            !h.openrouter_ready ? "OpenRouter" : null,
          ]
            .filter(Boolean)
            .join(" y ");
          setEnvWarning(
            `Faltan llaves de ${missing} en el backend. La práctica no funcionará hasta configurarlas en backend/.env.`
          );
        } else {
          setEnvWarning("");
        }
      })
      .catch(() => setEnvWarning("No se pudo contactar el backend (¿está corriendo en :8080?)."));
  }, [stage]);

  async function handleStart(target: TargetId, voice: VoiceGender) {
    setStarting(true);
    setStartError("");
    setLastTarget(target);
    setLastVoice(voice);
    try {
      const s = await startSession({
        target_mode: target,
        voice_gender: voice,
      });
      setSession(s);
      setStage("session");
    } catch (err) {
      setStartError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function handleFinish(
    transcript: TranscriptTurn[],
    durationSeconds: number
  ) {
    if (!session) return;
    setStage("evaluating");
    setEvalError("");
    try {
      const res = await endSession({
        session_id: session.session_id,
        target_mode: session.target_mode,
        transcript,
        duration_seconds: durationSeconds,
      });
      const label =
        TARGETS.find((t) => t.id === session.target_mode)?.label ??
        session.target_mode;
      setResult({
        evaluation: res.evaluation,
        metrics: res.metrics,
        targetLabel: label,
      });
      setStage("report");
    } catch (err) {
      setEvalError((err as Error).message);
      setStage("error");
    }
  }

  function reset() {
    setSession(null);
    setResult(null);
    setStage("select");
  }

  if (stage === "login") {
    return <Login onLogin={() => setStage("select")} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">SAS</span>
          <div>
            Simulador de Vocería C-level
            <br />
            <small>Entrenamiento de pitch ejecutivo · Sandra Hernández</small>
          </div>
        </div>
        <button onClick={() => setStage("login")}>Salir</button>
      </header>

      <main className="container">
        {envWarning && stage === "select" && (
          <div className="banner">⚠️ {envWarning}</div>
        )}

        {stage === "select" && (
          <ScenarioSelect
            onStart={handleStart}
            starting={starting}
            error={startError}
          />
        )}

        {stage === "session" && session && (
          <PracticeSession
            session={session}
            onFinish={handleFinish}
            onCancel={reset}
          />
        )}

        {stage === "evaluating" && (
          <div className="card center">
            <h1>Evaluando tu pitch…</h1>
            <div className="spinner" />
            <p className="muted">
              Calculando métricas y generando feedback con Claude Sonnet. Toma
              unos segundos.
            </p>
          </div>
        )}

        {stage === "report" && result && (
          <Report
            evaluation={result.evaluation}
            metrics={result.metrics}
            targetLabel={result.targetLabel}
            onRetry={() => handleStart(lastTarget, lastVoice)}
            onHome={reset}
          />
        )}

        {stage === "error" && (
          <div className="card center">
            <h1>No pudimos generar el reporte</h1>
            <p className="error">{evalError}</p>
            <div className="actions" style={{ justifyContent: "center" }}>
              <button
                className="btn btn-primary"
                style={{ width: "auto", paddingInline: 24 }}
                onClick={() => handleStart(lastTarget, lastVoice)}
              >
                Reintentar práctica
              </button>
              <button className="btn btn-ghost" onClick={reset}>
                Volver al inicio
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
