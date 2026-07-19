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
// last 15s / max red. Purely visual pacing cue now — it no longer cuts the
// session (see the turn-based ending logic below).
function timerClass(seconds: number): string {
  if (seconds >= TIMER.maxSeconds) return "is-max";
  if (seconds >= TIMER.idealSeconds) return "is-over";
  if (seconds >= TIMER.warnSeconds) return "is-ideal";
  return "";
}

// Silence after Sandra's answer to the 2nd repregunta before we auto-finish.
const SILENCE_END_MS = 3000;
// Absolute last-resort guard in case the conversation never naturally wraps
// (e.g. the agent hangs). Generous on purpose — this is not a pacing rule.
const ABSOLUTE_MAX_SECONDS = 600;

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

  // Turn tracking: agent speaking-turns go 1=consigna, 2=repregunta 1,
  // 3=repregunta 2, (4=cierre, which we don't wait for — see finalPhaseRef).
  const agentTurnCountRef = useRef(0);
  // Duration of the pitch ONLY (consigna → she stops talking, right before
  // repregunta 1). This is what actually gets validated against 90s/3min —
  // NOT the whole conversation, which naturally runs longer once the
  // back-and-forth starts.
  const pitchDurationRef = useRef<number | null>(null);
  // True once repregunta 2 has been asked and Sandra starts answering it.
  // While true, 3s of silence (no new transcript from her) ends the session.
  const finalPhaseRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      // Any fresh signal from Sandra during the final phase resets the
      // silence countdown — we only end once she's truly done talking.
      if (role === "user" && finalPhaseRef.current) {
        armSilenceTimer();
      }
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
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    const elapsed = startedAtRef.current
      ? Math.round((Date.now() - startedAtRef.current) / 1000)
      : seconds;
    // The report's duration check validates the PITCH, not the whole
    // conversation — fall back to total elapsed only if we somehow never
    // captured the pitch boundary (e.g. she ended the call early herself).
    const durationForReport = pitchDurationRef.current ?? elapsed;
    try {
      await conversation.endSession();
    } catch {
      /* ignore */
    }
    onFinish(transcriptRef.current, durationForReport);
  }, [conversation, onFinish, seconds]);

  const armSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => void finish(), SILENCE_END_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finish]);

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
      agentTurnCountRef.current += 1;
      const turn = agentTurnCountRef.current;

      // Turn 2 = repregunta 1 being asked → her pitch just ended, this is
      // the duration we actually validate (90s ideal / 3min max).
      if (turn === 2 && pitchDurationRef.current === null) {
        pitchDurationRef.current = startedAtRef.current
          ? Math.round((Date.now() - startedAtRef.current) / 1000)
          : seconds;
      }

      // Turn ≥4 means the agent is past repregunta 2 (closing message, or
      // an unexpected extra turn) while we were already in the final
      // phase — she's done, don't wait out the rest of the silence window.
      if (turn >= 4 && finalPhaseRef.current) {
        void finish();
      }
    } else if (mode === "listening" && agentSpokeRef.current) {
      beginRecording();
      // She just started answering repregunta 2 (turn 3 was the question).
      if (agentTurnCountRef.current === 3) {
        finalPhaseRef.current = true;
        armSilenceTimer();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, connecting, beginRecording, finish]);

  // Fallback: if the agent never speaks (edge case), start recording after a
  // short grace period so the exercise is never stuck.
  useEffect(() => {
    if (connecting) return;
    const id = setTimeout(() => beginRecording(), 9000);
    return () => clearTimeout(id);
  }, [connecting, beginRecording]);

  // Visible pacing clock only — does not end the session. Absolute safety
  // net far beyond any real conversation, in case the turn-based ending
  // above never fires (e.g. the agent hangs mid-conversation).
  useEffect(() => {
    if (!recording) return;
    intervalRef.current = setInterval(() => {
      setSeconds((prev) => {
        const next = prev + 1;
        if (next >= ABSOLUTE_MAX_SECONDS) void finish();
        return next;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [recording, finish]);

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

  return (
    <section className="screen screen--conversation">
      <header className="conversation-header">
        <img className="brand-logo" src="/assets/SmartPR_Logo.svg" alt="SmartPR" />
        <img className="sas-logo" src="/assets/SAS_Logo.svg" alt="SAS" />
      </header>

      <div className="conversation-center">
        <Orb variant="dark" state={orbState} />

        <p className="conversation-state">{stateLabel}</p>
        <p className={`conversation-timer ${timerClass(seconds)}`}>
          {fmt(seconds)}
        </p>
        <p className="conversation-question">{caption}</p>
        <p className="conversation-scenario">Escenario · {scenarioLabel}</p>
        <p className="conversation-hint">
          Ideal 1:30 · Máximo 3:00 para el pitch inicial
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
