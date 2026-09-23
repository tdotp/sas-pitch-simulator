// Shared domain types for the SAS pitch simulator backend.

// Phase 5 (ENGINE vs CONFIG): TargetMode used to be a closed union
// ("generic" | "davivienda" | "grupo_aval") that every layer branched on
// — exactly the client-specific hardcoding this phase eliminates. The
// new domain concept is `scenarioId` (a plain string, resolved within an
// organization's config package — see engine-config/schema.ts). This
// alias exists ONLY for the request/response wire field named
// `target_mode`, kept unchanged so the current frontend needs zero
// changes (see FRONTEND_COMPATIBILITY in
// PHASE_05_ENGINE_CONFIG_REPORT.md). Nothing in backend/src/engine/* or
// engine-config/* uses this type — they only ever see scenarioId
// strings.
export type TargetMode = string;

export type VoiceGender = "male" | "female" | "random";

// Phase 1: identity is NOT part of this request's contract. user_id/user_name
// used to be client-supplied fields here; they're derived exclusively from
// the verified Firebase ID token (see requireAuth + req.auth in routes.ts)
// and must never come from the request body again.
//
// Phase 5: `target_mode` is the DEPRECATED wire-compat name for what the
// engine calls `scenarioId` — see routes.ts's /session/start, which reads
// this field but treats its value as a scenario id to resolve within the
// caller's organization, never as a closed enum.
export interface StartSessionRequest {
  target_mode: TargetMode;
  voice_gender?: VoiceGender; // only meaningful when the profile's voice slot is "random"
}

// Phase 4 — explicit session lifecycle (see PHASE_04_SESSION_LIFECYCLE_REPORT.md
// for the full state machine, SESSION_STATE_MODEL and VALID_TRANSITIONS).
// Replaces the old, ambiguous "in_progress" | "completed" | "error" set —
// "error" was never actually written anywhere; this makes explicit what
// Phase 3 already needed but didn't have: separate states for "the
// conversation is happening", "an evaluation is currently claimed/running"
// (used for concurrency control), and — critically — WHY a session never
// reached "completed" (evaluation failed vs. the result failed to persist
// are different failures with different recovery paths).
export type SessionStatus =
  | "in_progress" // conversation happening; nothing has claimed it for evaluation yet
  | "evaluating" // /session/end claimed it; evaluation is running (concurrency guard)
  | "completed" // evaluation succeeded AND the result is durably persisted
  | "evaluation_failed" // OpenRouter/evaluator failed (timeout, 4xx/5xx, bad JSON, ...)
  | "persistence_failed" // evaluation succeeded but the final Firestore write failed
  | "abandoned"; // in_progress for too long, never reached /session/end

export interface SessionRecord {
  session_id: string;
  user_id: string;
  user_name: string;
  // Phase 5: the canonical field going forward — a scenario id resolved
  // within `organization_id`'s config package (see
  // engine-config/resolver.ts). `target_mode` below is kept as a
  // deprecated MIRROR of this same value, written only so existing
  // reads of the API response (frontend) and any tooling querying
  // Firestore by the old field name keep working during the transition.
  scenario_id: string;
  target_mode: TargetMode;
  voice_gender: VoiceGender;
  voice_id: string;
  status: SessionStatus;
  started_at: string;
  ended_at?: string;
  duration_seconds?: number;
  // Firebase uid that started the session. Used for the /session/end
  // ownership check (Phase 3: starter uid === authenticated uid, checked
  // against the PERSISTED record via repositories/sessions.ts, not an
  // in-memory Map — durable across restarts/instances).
  owner_uid?: string;
  // Tenant ownership (Phase 3): the Organization this session belongs to,
  // taken exclusively from req.appContext.organizationId at /session/start
  // — never from the client. Required for every session created from
  // Phase 3 onward. Sessions written before Phase 3 (legacy Firestore
  // docs) don't have it — repositories/sessions.ts treats a doc missing
  // this field as invalid/not found rather than exposing it without a
  // tenant (see LEGACY_SESSION_POLICY in
  // PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md). Optional in the type only
  // to reflect that Firestore reality, not because a newly created
  // session may omit it.
  organization_id?: string;
  // Phase 6 — PROVENANCE_MODEL: exactly which config a session used,
  // pinned at /session/start and never re-derived. `scenario_id` above is
  // NOT repeated here (it's already the canonical top-level field for the
  // same session; duplicating it would be exactly the "duplicación
  // innecesaria" the Phase 6 prompt asked to avoid) — everything else
  // needed to reproduce/audit which exact config a session ran against
  // lives here. Absent on sessions created before Phase 6 (see
  // LEGACY_SESSION_POLICY in PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT.md)
  // — repositories/sessions.ts and routes.ts treat a missing
  // config_version as "unknown provenance", never a guessed version.
  config_provenance?: {
    config_version: string;
    interviewer_profile_id: string;
    evaluation_framework_id: string;
    content_source_ids: string[];
    // SHA-256 of the resolved package at the moment this session started
    // — see engine-config/configHash.ts. Lets a later audit detect "the
    // version id says v1 but the files don't match what v1 looked like
    // when this session ran" (IMMUTABILITY_POLICY).
    config_hash: string;
  };
  // Phase 4: when status is evaluation_failed or persistence_failed, a
  // short, safe, human-readable reason — never a stack trace, never a
  // secret (API keys, tokens). Truncated at write time; see
  // repositories/sessions.ts.
  failure_reason?: string;
  // Phase 4: set whenever the document is written, independent of
  // status — lets an abandonment sweep find "in_progress for a long time"
  // without a separate timestamp per transition. ISO 8601.
  updated_at?: string;
  // Phase 4: full persisted result, present only once status === "completed".
  // Kept optional because most statuses never have it — the type mirrors
  // what's actually possible in Firestore.
  transcript?: { full: string; user_only: string; agent_only: string };
  metrics?: SpeechMetrics;
  evaluation?: EvaluationResult;
}

// ─────────────────────────────────────────────────────────────
// Phase 2 — Organization / Membership / Role domain model.
// Identity keeps coming exclusively from Firebase Auth (see
// middleware/auth.ts). These types describe APPLICATION identity/
// membership data, persisted in Firestore, which Firebase Auth itself
// knows nothing about.
// ─────────────────────────────────────────────────────────────

export type Role = "AGENCY_ADMIN" | "CLIENT_ADMIN" | "COACH" | "SPOKESPERSON";

export type EntityStatus = "active" | "inactive";

// Represents a client/tenant of the platform. Deliberately minimal — no
// client configuration (scenarios, rubrics, prompts) lives here yet; that
// is Phase 5 (ENGINE vs CONFIG), not this phase.
export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: EntityStatus;
  created_at: string; // ISO 8601
  updated_at: string;
}

// Minimal application-level profile for a Firebase user. NEVER stores a
// password or any auth secret — Firebase Auth remains the sole
// authentication authority. This is just bookkeeping metadata Firestore
// knows about a person.
export interface AppUser {
  uid: string; // Firebase uid — same id space, not a separate identity
  email: string | null;
  display_name: string | null;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
}

// Links one Firebase user to one Organization with one Role. A user MAY
// have more than one Membership (different organizations — this is what
// lets AGENCY_ADMIN eventually span several). The (user_id, organization_id)
// pair is unique by construction: see membershipId() in
// repositories/memberships.ts, which derives a deterministic Firestore
// document id from that pair instead of relying on a query-time
// uniqueness check.
export interface Membership {
  id: string; // == membershipId(user_id, organization_id)
  user_id: string; // Firebase uid
  organization_id: string;
  role: Role;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
}

// Server-resolved application context for the current request. NEVER
// derived from anything the client sends — see resolveAppContext in
// services/context.ts. organizationId/role always come from a Membership
// document read from Firestore, keyed by the verified uid.
export interface AppContext {
  userId: string; // Firebase uid
  email: string | null;
  organizationId: string;
  role: Role;
}

// Transcript turn as delivered by ElevenLabs (or built client-side).
export interface TranscriptTurn {
  role: "user" | "agent";
  text: string;
  // seconds from session start, optional
  t?: number;
}

export interface SpeechMetrics {
  word_count: number;
  words_per_minute: number;
  filler_words_total: number;
  filler_words_items: Record<string, number>;
  repetition_count: number;
  repetition_items: string[];
  long_pauses_count: number;
  used_numbers: boolean;
  numbers_detected: string[];
  has_cta: boolean;
}

export interface EvaluateRequest {
  session_id: string;
  target_mode: TargetMode;
  transcript: TranscriptTurn[];
  duration_seconds: number;
}

// The evaluator (Claude Sonnet) returns this shape. Mirrors
// prompt_evaluador_universal_sas.md output contract.
export interface EvaluationResult {
  session_id: string;
  target_mode: string;
  overall_score: number;
  readiness_level: "bajo" | "medio" | "alto" | "sobresaliente";
  one_line_diagnosis: string;
  executive_summary: string;
  duration: {
    seconds: number;
    formatted: string;
    ideal_seconds: number;
    max_seconds: number;
    status: "ideal" | "aceptable" | "largo" | "fuera_de_rango";
    comment: string;
  };
  // Phase 5 fix (PASS_WITH_FIXES): used to be a fixed object with
  // client-specific keys (mentioned_sas, aligned_to_playbook) baked into
  // this universal contract. Now a generic list, one entry per
  // requirement DECLARED BY THE FRAMEWORK (EvaluationFramework.requirements
  // in engine-config/schema.ts) — adding, removing or renaming a
  // requirement for any client is a config change, never a change to this
  // type or to engine code. `id` mirrors the framework's requirement id.
  // `description` is never produced by the LLM — services/evaluator.ts
  // enriches the model's {id, detected, evidence} with the matching
  // EvaluationFramework.requirements[].description AFTER the model
  // responds (see enrichDetectedRequirements). This keeps the label
  // authoritative from config always, never a client-specific string
  // baked into a prompt or invented by the frontend/LLM.
  detected_requirements: Array<{
    id: string;
    description: string;
    detected: boolean;
    evidence: string;
  }>;
  speech_metrics: {
    word_count: number;
    words_per_minute: number;
    filler_words_total: number;
    top_filler_words: string[];
    repetition_count: number;
    top_repetitions: string[];
    long_pauses_count: number;
    // Deterministic, generic signals (computed by services/metrics.ts,
    // never LLM-judged) — moved here from the old detected_requirements
    // object since they're metrics, not framework-defined requirements.
    used_numbers: boolean;
    numbers_detected: string[];
    has_cta: boolean;
    comment: string;
  };
  criteria_scores: Array<{
    criterion_id: string;
    criterion_name: string;
    score: number;
    max_score: number;
    evidence: string;
    comment: string;
    recommendation: string;
  }>;
  strengths: string[];
  improvement_areas: string[];
  critical_flags: Array<{
    flag: string;
    severity: "low" | "medium" | "high";
    comment: string;
  }>;
  missed_opportunities: string[];
  best_line_from_user: string;
  weakest_line_from_user: string;
  recommended_pitch_90_seconds: string;
  recommended_pitch_45_seconds: string;
  recommended_cta: string;
  next_training_focus: string[];
  coach_feedback: string;
}
