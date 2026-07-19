import { useCallback, useEffect, useState } from "react";
import { Login } from "./components/Login";
import { ScenarioSelect } from "./components/ScenarioSelect";
import { Preparation } from "./components/Preparation";
import { PracticeSession } from "./components/PracticeSession";
import { Report } from "./components/Report";
import { Analysis } from "./components/Analysis";
import { startSession, endSession, health } from "./api";
import { TARGETS, type TargetId } from "./config";
import type {
  EvaluationResult,
  SpeechMetrics,
  StartSessionResponse,
  TranscriptTurn,
  VoiceGender,
} from "./types";

type Stage =
  | "login"
  | "select"
  | "preparation"
  | "session"
  | "evaluating"
  | "report"
  | "analysis"
  | "error";

function labelFor(target: TargetId): string {
  return TARGETS.find((t) => t.id === target)?.label ?? target;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("login");
  const [session, setSession] = useState<StartSessionResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [prepError, setPrepError] = useState("");
  const [evalError, setEvalError] = useState("");
  const [result, setResult] = useState<{
    evaluation: EvaluationResult;
    metrics: SpeechMetrics;
    targetLabel: string;
  } | null>(null);
  const [lastTarget, setLastTarget] = useState<TargetId>("generic");
  const [lastVoice, setLastVoice] = useState<VoiceGender>("random");
  const [envWarning, setEnvWarning] = useState("");

  // Health check when landing on the selection screen.
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
            `Faltan llaves de ${missing} en el backend (backend/.env).`
          );
        } else {
          setEnvWarning("");
        }
      })
      .catch(() =>
        setEnvWarning("No se pudo contactar el backend (¿corre en :8080?).")
      );
  }, [stage]);

  // Go to preparation and prefetch a fresh signed URL for the scenario.
  const prepare = useCallback(
    async (target: TargetId, voice: VoiceGender) => {
      setLastTarget(target);
      setLastVoice(voice);
      setSession(null);
      setPrepError("");
      setStarting(true);
      setStage("preparation");
      try {
        const s = await startSession({ target_mode: target, voice_gender: voice });
        setSession(s);
      } catch (err) {
        setPrepError((err as Error).message);
      } finally {
        setStarting(false);
      }
    },
    []
  );

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
      setResult({
        evaluation: res.evaluation,
        metrics: res.metrics,
        targetLabel: labelFor(session.target_mode),
      });
      setStage("report");
    } catch (err) {
      setEvalError((err as Error).message);
      setStage("error");
    }
  }

  function toSelect() {
    setSession(null);
    setResult(null);
    setStage("select");
  }

  switch (stage) {
    case "login":
      return <Login onLogin={() => setStage("select")} />;

    case "select":
      return (
        <>
          {envWarning && <div className="env-banner">⚠️ {envWarning}</div>}
          <ScenarioSelect onContinue={prepare} />
        </>
      );

    case "preparation":
      return (
        <Preparation
          ready={!!session}
          starting={starting}
          error={prepError}
          onStart={() => setStage("session")}
          onBack={toSelect}
        />
      );

    case "session":
      return session ? (
        <PracticeSession
          session={session}
          scenarioLabel={labelFor(session.target_mode)}
          onFinish={handleFinish}
          onCancel={toSelect}
        />
      ) : null;

    case "evaluating":
      return (
        <section className="screen screen--processing">
          <div className="processing-content">
            <div className="processing-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="eyebrow">Análisis en curso</p>
            <h1 className="display-title display-title--processing">
              Preparando tu
              <br />
              retroalimentación.
            </h1>
            <p className="lead">
              Calculando métricas y generando feedback con Claude Sonnet.
            </p>
          </div>
        </section>
      );

    case "report":
      return result ? (
        <Report
          evaluation={result.evaluation}
          metrics={result.metrics}
          targetLabel={result.targetLabel}
          onRetry={() => prepare(lastTarget, lastVoice)}
          onAnalysis={() => setStage("analysis")}
        />
      ) : null;

    case "analysis":
      return result ? (
        <Analysis
          evaluation={result.evaluation}
          metrics={result.metrics}
          targetLabel={result.targetLabel}
          onRestart={toSelect}
          onContinue={() => prepare(lastTarget, lastVoice)}
        />
      ) : null;

    case "error":
      return (
        <section className="screen screen--processing">
          <div className="processing-content">
            <h1 className="display-title display-title--processing">
              No pudimos generar el reporte
            </h1>
            <p className="processing-error">{evalError}</p>
            <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
              <button
                className="primary-button"
                onClick={() => prepare(lastTarget, lastVoice)}
              >
                Reintentar práctica
              </button>
              <button className="text-button" onClick={toSelect}>
                Volver al inicio
              </button>
            </div>
          </div>
        </section>
      );

    default:
      return null;
  }
}
