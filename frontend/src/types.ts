// Shared shapes mirrored from the backend (evaluation contract).

export type TargetMode = "generic" | "davivienda" | "grupo_aval";
export type VoiceGender = "male" | "female" | "random";

export interface TranscriptTurn {
  role: "user" | "agent";
  text: string;
  t?: number;
}

export interface AgentOverrides {
  agent: { prompt: { prompt: string }; first_message: string; language: string };
  tts: { voice_id: string };
}

export interface StartSessionResponse {
  session_id: string;
  target_mode: TargetMode;
  agent_id: string;
  signed_url: string;
  voice_id: string;
  voice_gender: VoiceGender;
  overrides: AgentOverrides;
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
  critical_flags: Array<{ flag: string; severity: string; comment: string }>;
  missed_opportunities: string[];
  best_line_from_user: string;
  weakest_line_from_user: string;
  recommended_pitch_90_seconds: string;
  recommended_pitch_45_seconds: string;
  recommended_cta: string;
  next_training_focus: string[];
  coach_feedback: string;
}

export interface EndSessionResponse {
  session_id: string;
  target_mode: TargetMode;
  metrics: SpeechMetrics;
  evaluation: EvaluationResult;
}
