import { useEffect, useRef, useState, useCallback } from "react";
import { useConversation } from "@elevenlabs/react";
import { TIMER } from "../config";
import type { StartSessionResponse, TranscriptTurn } from "../types";
import { Orb, type OrbState } from "./Orb";

// Map backend (snake_case, REST) overrides to the SDK's camelCase shape.
function toSdkOverrides(o: StartSessionResponse["overrides"]) {
  return {
    agent: {
      prompt: { prompt: o.agent.prompt.prompt },
      firstMessage: o.agent.first_message,
      language: o.agent.language,
    },
    tts: { voiceId: o.tts.voice_id },
  };
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// Timer color tram per the brief: <60 neutral · 60–90 sweet spot · 90–180 over ·
// last 15s / max red.
function timerClass(seconds: number): string {
  if (seconds >= TIMER.maxSeconds - 15) return "is-max";
  if (seconds >= TIMER.idealSeconds) return "is-over";
  if (seconds >= TIMER.warnSeconds) return "is-ideal";
  return "";
}

export function PracticeSession({
  session,
  scenarioLabel,
  onFinish,
  onCancel,
}: {
  session: StartSessionResponse;
  scenarioLabel: string;
  onFinish: (transcript: TranscriptTurn[], durationSeconds: number) => void;
  onCancel: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [connecting, setConnecting] = useState(true);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState("");
  const [latestAgentMsg, setLatestAgentMsg] = useState("");

  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const startedAtRef = useRef<number>(0);
  const agentSpokeRef = useRef(false);
  const recordingRef = useRef(false);
  const endedRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set once the max duration is reached. We don't cut immediately — we wait
  // for Sandra's current turn to end (mode leaves "listening") so an in-flight
  // answer is never sliced mid-sentence. `modeRef` mirrors `mode` for use
  // inside the interval callback without re-subscribing the interval.
  const hitMaxRef = useRef(false);
  const modeRef = useRef<string>("listening");

  const conversation = useConversation({
    onConnect: () => setConnecting(false),
    onDisconnect: () => {
      /* handled explicitly in finish() */
    },
    onMessage: (payload: { message: string; source: string }) => {
      const role: TranscriptTurn["role"] =
        payload.source === "user" ? "user" : "agent";
      const t = startedAtRef.current
        ? Math.round((Date.now() - startedAtRef.current) / 1000)
        : 0;
      transcriptRef.current.push({ role, text: payload.message, t });
      if (role === "agent") setLatestAgentMsg(payload.message);
    },
    onError: (message: string) => {
      setMicError(message || "Error de conexión con el agente de voz.");
      setConnecting(false);
    },
  });

  const isSpeaking = conversation.isSpeaking;
  // `mode` is a per-turn signal ("speaking" while the agent holds the floor,
  // "listening" once it yields). It's far more stable than `isSpeaking`, which
  // flickers on TTS micro-gaps between sentences.
  const mode = conversation.mode;

  const finish = useCallback(async () => {
    if (endedRef.current) return;
    endedRef.current = true;
    if (intervalRef.current) clearInterval(intervalRef.current);
    const elapsed = startedAtRef.current
      ? Math.round((Date.now() - startedAtRef.current) / 1000)
      : seconds;
    try {
      await conversation.endSession();
    } catch {
      /* ignore */
    }
    onFinish(transcriptRef.current, elapsed);
  }, [conversation, onFinish, seconds]);

  // Start the ElevenLabs conversation once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) return;
        await conversation.startSession({
          signedUrl: session.signed_url,
          connectionType: "websocket",
          overrides: toSdkOverrides(session.overrides),
        } as Parameters<typeof conversation.startSession>[0]);
      } catch (err) {
        if (!cancelled)
          setMicError(
            (err as Error).message ||
              "No se pudo acceder al micrófono o conectar el agente."
          );
      }
    })();
    return () => {
      cancelled = true;
      try {
        void conversation.endSession();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Speak-first-then-record: the agent delivers the consigna; the pitch timer
  // starts only once the agent FINISHES its first utterance.
  const beginRecording = useCallback(() => {
    if (recordingRef.current) return;
    recordingRef.current = true;
    startedAtRef.current = Date.now();
    setRecording(true);
  }, []);

  useEffect(() => {
    if (connecting) return;
    if (mode === "speaking") {
      agentSpokeRef.current = true;
    } else if (mode === "listening" && agentSpokeRef.current) {
      beginRecording();
    }
  }, [mode, connecting, beginRecording]);

  // Graceful cutoff: once time is up, end the session the moment Sandra's
  // current turn finishes (mode flips back to "speaking", i.e. the agent is
  // about to reply) — never while she's mid-answer.
  useEffect(() => {
    modeRef.current = mode;
    if (hitMaxRef.current && mode === "speaking") {
      void finish();
    }
  }, [mode, finish]);

  // Fallback: if the agent never speaks (edge case), start recording after a
  // short grace period so the exercise is never stuck.
  useEffect(() => {
    if (connecting) return;
    const id = setTimeout(() => beginRecording(), 9000);
    return () => clearTimeout(id);
  }, [connecting, beginRecording]);

  // Pitch timer. At the max duration we don't cut immediately — we set
  // hitMaxRef and let the mode-change effect above cut right after Sandra's
  // current turn ends. Safety net: force-finish a bit past the max in case
  // the agent never yields the floor (e.g. it hangs).
  const SAFETY_NET_SECONDS = TIMER.maxSeconds + 45;
  useEffect(() => {
    if (!recording) return;
    intervalRef.current = setInterval(() => {
      setSeconds((prev) => {
        const next = prev + 1;
        if (next >= TIMER.maxSeconds && !hitMaxRef.current) {
          hitMaxRef.current = true;
          // Edge case: time ran out exactly while the agent already holds
          // the floor — cut right away instead of waiting for a transition
          // that already happened.
          if (modeRef.current === "speaking") void finish();
        }
        if (next >= SAFETY_NET_SECONDS) {
          void finish();
        }
        return next;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [recording, finish, SAFETY_NET_SECONDS]);

  if (micError) {
    return (
      <section className="screen screen--processing">
        <div className="processing-content">
          <h1 className="display-title display-title--processing">
            No pudimos iniciar
          </h1>
          <p className="processing-error">{micError}</p>
          <p className="lead">
            Revisa el permiso de micrófono y que el backend tenga las llaves de
            ElevenLabs.
          </p>
          <button
            className="primary-button"
            style={{ marginTop: 24 }}
            onClick={onCancel}
          >
            Volver
          </button>
        </div>
      </section>
    );
  }

  // Orb + state label.
  let orbState: OrbState = "listening";
  let stateLabel = "Escuchando";
  if (connecting) {
    orbState = "thinking";
    stateLabel = "Conectando…";
  } else if (isSpeaking) {
    orbState = "speaking";
    stateLabel = "Interlocutor hablando";
  } else if (!recording) {
    orbState = "thinking";
    stateLabel = "Preparando…";
  }

  const caption =
    latestAgentMsg ||
    "Escucha la consigna del interlocutor y arranca tu pitch cuando termine.";

  // Freeze the visible clock at the max so it never shows e.g. "3:15" while
  // we're waiting (internally) for Sandra's current turn to end gracefully.
  const displaySeconds = Math.min(seconds, TIMER.maxSeconds);

  return (
    <section className="screen screen--conversation">
      <header className="conversation-header">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
        <img className="sas-logo" src="/assets/SAS_Logo.svg" alt="SAS" />
      </header>

      <div className="conversation-center">
        <Orb variant="dark" state={orbState} />

        <p className="conversation-state">{stateLabel}</p>
        <p className={`conversation-timer ${timerClass(displaySeconds)}`}>
          {fmt(displaySeconds)}
        </p>
        <p className="conversation-question">{caption}</p>
        <p className="conversation-scenario">Escenario · {scenarioLabel}</p>
        <p className="conversation-hint">
          Ideal 1:30 · Máximo 3:00
        </p>

        <div className="conversation-actions">
          <button
            className="ghost-button is-primary"
            onClick={() => void finish()}
            disabled={connecting}
          >
            Finalizar y evaluar
          </button>
          <button className="ghost-button" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </section>
  );
}
