// Fase 7: structured logging, no external platform (dashboards are Fase 8
// — see STRUCTURED_LOGGING in PHASE_07_RELIABILITY_PROVIDER_HARDENING_REPORT.md).
//
// PASS_WITH_FIXES (P2): LogFields is a typed whitelist, not a guarantee.
// Passing an object literal with a field outside this interface (an API
// key, an Authorization header, a signed URL, a service account, a full
// transcript, a raw provider body) fails TypeScript's excess-property
// check IF the object is a literal passed directly to logEvent(...) — the
// pattern every current call site uses. That check is a compiler
// convenience, not a runtime enforcement: assigning the object to a
// variable first, an `as LogFields` cast, or spreading from an untyped
// source all silently bypass it. There is no runtime scrubber in this
// phase; a future call site that builds its fields dynamically needs its
// own explicit validation, not an assumption that this interface still
// protects it.
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
  // Fase 8 — COMMON_LOG_FIELDS. request_id/user_id/role/method/endpoint/
  // status_code round out HTTP request observability; rate_limit_scope
  // identifies which limiter (user/organization/global) rejected a
  // request. user_id is the Firebase uid (a technical identifier, never
  // an email) — see REDACTION_POLICY in
  // PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT.md for why email/PII never
  // belongs here.
  request_id?: string;
  user_id?: string;
  role?: string;
  method?: string;
  endpoint?: string;
  status_code?: number;
  rate_limit_scope?: "user" | "organization" | "global" | "ip";
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
