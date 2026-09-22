// Shared domain types for the SAS pitch simulator backend.

export type TargetMode = "generic" | "davivienda" | "grupo_aval";

// Rubric target ids as used in rubricas_sas.json.
export type RubricKey =
  | "generic"
  | "davivienda_javier_suarez"
  | "grupo_aval_maria_lorena";

export type VoiceGender = "male" | "female" | "random";

// Phase 1: identity is NOT part of this request's contract. user_id/user_name
// used to be client-supplied fields here; they're derived exclusively from
// the verified Firebase ID token (see requireAuth + req.auth in routes.ts)
// and must never come from the request body again.
export interface StartSessionRequest {
  target_mode: TargetMode;
  voice_gender?: VoiceGender; // only meaningful for generic
}

export interface SessionRecord {
  session_id: string;
  user_id: string;
  user_name: string;
  target_mode: TargetMode;
  voice_gender: VoiceGender;
  voice_id: string;
  status: "in_progress" | "completed" | "error";
  started_at: string;
  ended_at?: string;
  duration_seconds?: number;
  // Firebase uid that started the session. saveSessionStart persists the
  // full SessionRecord (spread), so this field DOES end up in Firestore —
  // it is not memory-only. However, the Phase 1 ownership check on
  // /session/end reads it EXCLUSIVELY from the in-memory `sessions` Map in
  // routes.ts, never from Firestore. That check is therefore still not
  // durable (lost on process restart, doesn't work across instances) even
  // though the underlying data is. A durable ownership check that reads
  // this field back from Firestore is Phase 4 (session lifecycle), not
  // implemented yet.
  owner_uid?: string;
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
  mentioned_sas: boolean;
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
  detected_requirements: {
    mentioned_sas: boolean;
    used_numbers: boolean;
    numbers_detected: string[];
    has_cta: boolean;
    aligned_to_playbook: boolean;
  };
  speech_metrics: {
    word_count: number;
    words_per_minute: number;
    filler_words_total: number;
    top_filler_words: string[];
    repetition_count: number;
    top_repetitions: string[];
    long_pauses_count: number;
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
