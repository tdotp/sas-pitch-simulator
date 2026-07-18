import { TIMER } from "../config";

export type TimerState = "normal" | "approaching" | "over-ideal" | "max";

export function timerState(seconds: number): TimerState {
  if (seconds >= TIMER.maxSeconds) return "max";
  if (seconds >= TIMER.idealSeconds) return "over-ideal";
  if (seconds >= TIMER.warnSeconds) return "approaching";
  return "normal";
}

const STATE_COLOR: Record<TimerState, string> = {
  normal: "#0b1f33",
  approaching: "#0072c6",
  "over-ideal": "#d98a00",
  max: "#e4002b",
};

const STATE_HINT: Record<TimerState, string> = {
  normal: "En tiempo",
  approaching: "Acercándote al ideal (90 s)",
  "over-ideal": "Superaste el ideal · sigues dentro del máximo",
  max: "Límite de 3 minutos alcanzado",
};

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Timer({ seconds }: { seconds: number }) {
  const state = timerState(seconds);
  const pct = Math.min(100, (seconds / TIMER.maxSeconds) * 100);
  return (
    <div className="session-stage" style={{ width: "100%" }}>
      <div className={`timer ${state}`}>{formatTime(seconds)}</div>
      <div className="timer-track">
        <div
          className="timer-fill"
          style={{ width: `${pct}%`, background: STATE_COLOR[state] }}
        />
      </div>
      <div className="timer-legend">
        <span>
          Ideal <b>1:30</b>
        </span>
        <span>
          Máximo <b>3:00</b>
        </span>
        <span style={{ color: STATE_COLOR[state], fontWeight: 600 }}>
          {STATE_HINT[state]}
        </span>
      </div>
    </div>
  );
}
