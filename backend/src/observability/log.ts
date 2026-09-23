// Fase 7: structured logging, no external platform (dashboards are Fase 8
// — see STRUCTURED_LOGGING in PHASE_07_RELIABILITY_PROVIDER_HARDENING_REPORT.md).
//
// LogFields is a closed field whitelist, not a convention — a caller that
// tries to log anything outside it (an API key, an Authorization header, a
// signed URL, a service account, a full transcript, a raw provider body)
// gets a TypeScript excess-property error on the object literal at compile
// time. That's the redaction policy: enforced by the type checker, not by
// a runtime scrub-by-key-name pass that could be bypassed or forgotten.
export interface LogFields {
  event: string;
  session_id?: string;
  organization_id?: string;
  config_version?: string;
  scenario_id?: string;
  provider?: "openrouter" | "elevenlabs" | "firestore";
  attempt?: number;
  duration_ms?: number;
  outcome?: "success" | "failure" | "retry";
  error_category?: string;
}

export function logEvent(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

// Whole-millisecond latency since `startMs` (a Date.now() reading taken by
// the caller before the operation started). Used for OpenRouter/ElevenLabs
// attempt latency and critical Firestore write latency.
export function elapsedMs(startMs: number): number {
  return Date.now() - startMs;
}
