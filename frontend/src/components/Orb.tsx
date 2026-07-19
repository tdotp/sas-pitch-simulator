// Animated voice orb (SVG blobs + CSS). Ported from the SmartPR prototype.
// `state` drives speed/scale/glow: idle | listening | thinking | speaking.

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export function Orb({
  variant = "dark",
  state = "idle",
}: {
  variant?: "light" | "dark";
  state?: OrbState;
}) {
  return (
    <div
      className={`smart-orb smart-orb--${variant}`}
      data-orb-state={state}
      aria-hidden="true"
    >
      <div className="orb-glow" />
      <svg className="orb-svg" viewBox="0 0 1200 1200">
        <g className="blob blob-1">
          <path d="M100 600q0-500 500-500t500 500t-500 500T100 600z" />
        </g>
        <g className="blob blob-2">
          <path d="M100 600q0-400 500-500t400 500t-500 500T100 600z" />
        </g>
        <g className="blob blob-3">
          <path d="M100 600q-50-400 500-500t450 550t-500 500T100 600z" />
        </g>
        <g className="blob blob-4">
          <path d="M150 600q0-600 500-500t500 550t-500 500T150 600z" />
        </g>
        <g className="blob blob-1 alt">
          <path d="M100 600q0-500 500-500t500 500t-500 500T100 600z" />
        </g>
        <g className="blob blob-2 alt">
          <path d="M100 600q0-400 500-500t400 500t-500 500T100 600z" />
        </g>
      </svg>
      <div className="orb-glass" />
    </div>
  );
}
