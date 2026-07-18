import { useEffect, useRef, useState, useCallback } from "react";
import { useConversation } from "@elevenlabs/react";
import { TIMER } from "../config";
import type { StartSessionResponse, TranscriptTurn } from "../types";
import { Timer } from "./Timer";

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

export function PracticeSession({
  session,
  onFinish,
  onCancel,
}: {
  session: StartSessionResponse;
  onFinish: (transcript: TranscriptTurn[], durationSeconds: number) => void;
  onCancel: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [connecting, setConnecting] = useState(true);
  const [micError, setMicError] = useState("");
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const [, forceRender] = useState(0);
  const startedAtRef = useRef<number>(0);
  const endedRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const conversation = useConversation({
    onConnect: () => {
      setConnecting(false);
      startedAtRef.current = Date.now();
    },
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
      forceRender((n) => n + 1);
    },
    onError: (message: string) => {
      setMicError(message || "Error de conexión con el agente de voz.");
      setConnecting(false);
    },
  });

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

  // Timer tick; auto-cut at the max.
  useEffect(() => {
    if (connecting) return;
    intervalRef.current = setInterval(() => {
      setSeconds((prev) => {
        const next = prev + 1;
        if (next >= TIMER.maxSeconds) {
          void finish();
          return TIMER.maxSeconds;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [connecting, finish]);

  const isSpeaking = conversation.isSpeaking;
  const turns = transcriptRef.current;

  if (micError) {
    return (
      <div className="card center">
        <h1>No pudimos iniciar la sesión</h1>
        <p className="error">{micError}</p>
        <p className="muted">
          Revisa el permiso de micrófono y que el backend tenga configuradas las
          llaves de ElevenLabs.
        </p>
        <button className="btn btn-ghost" onClick={onCancel}>
          Volver
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="center" style={{ marginBottom: 8 }}>
        <span
          className={`status-pill ${
            connecting ? "status-connecting" : "status-live"
          }`}
        >
          {connecting ? "Conectando con el interlocutor…" : "En vivo"}
        </span>
      </div>

      <div className="session-stage">
        <div className={`orb ${isSpeaking ? "speaking" : ""}`} />
        <Timer seconds={seconds} />

        <div className="actions" style={{ justifyContent: "center" }}>
          <button
            className="btn btn-danger"
            onClick={() => void finish()}
            disabled={connecting}
          >
            Finalizar y evaluar
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
        </div>

        {turns.length > 0 && (
          <div className="transcript">
            {turns.map((turn, i) => (
              <div key={i} className={`bubble ${turn.role}`}>
                {turn.text}
              </div>
            ))}
          </div>
        )}
        {turns.length === 0 && !connecting && (
          <p className="muted center" style={{ marginTop: 16 }}>
            El interlocutor te dará la consigna. Cuando termine, empieza tu
            pitch.
          </p>
        )}
      </div>
    </div>
  );
}
