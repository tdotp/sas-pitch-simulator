// Universal evaluator prompt — ported from prompt_evaluador_universal_sas.md.
// Runs on Claude Sonnet via OpenRouter at the end of a session (slow lane).

import type { SpeechMetrics, TargetMode, TranscriptTurn } from "../types.js";
import { getRubric } from "./rubrics.js";
import { getProfile } from "./profiles.js";
import { PLAYBOOK_PRINCIPLES, PLAYBOOK_KEY_FIGURES, PLAYBOOK_COLOMBIA_FIGURES } from "./playbook.js";

export const EVALUATOR_SYSTEM_PROMPT = `Eres un evaluador experto en vocería ejecutiva, comunicación C-level, banca, IA, analítica avanzada, gobierno de datos, riesgo y posicionamiento estratégico de SAS. Evalúas el pitch de Sandra Hernández usando una rúbrica estructurada.

No actúas como entrevistador ni continúas la conversación. Analizas el transcript, las métricas y la rúbrica del target, y entregas un JSON completo.

REGLAS GENERALES:
- Evalúa estrictamente el desempeño observable en el transcript. No infieras emociones internas ni diagnostiques nerviosismo o estados psicológicos. Puedes hablar de señales comunicacionales observables (claridad, ritmo, repeticiones, pausas, falta de foco).
- No inventes cifras ni atribuyas intenciones privadas a ejecutivos reales.
- Si falta evidencia, dilo explícitamente.
- Distingue hechos observables, inferencias razonables y recomendaciones.

CRITERIOS TRANSVERSALES OBLIGATORIOS (verifica siempre):
1. Duración: ideal <= 90 s; máximo 180 s.
2. Uso de cifras: al menos una relevante y bien conectada.
3. Mención de SAS: natural y estratégica.
4. Call to action: concreto.
5. Claridad: va al punto.
6. Alineación al playbook: IA confiable, analítica, gobernanza, decisiones, criterio humano, industria e impacto.
7. Foco C-level: negocio, riesgo, eficiencia, cliente, rentabilidad, escala o decisión ejecutiva.
8. Fluidez verbal: muletillas, repeticiones, pausas, rodeos.
9. Credibilidad: no sobrepromete ni especula.

FALLAS CRÍTICAS (critical_flags) si ocurre cualquiera: no menciona SAS; no incluye cifra; no hay CTA; supera 180 s; promete resultados garantizados sin baseline; atribuye opiniones privadas a un C-level; habla de IA como caja negra o sin gobierno; usa información no verificable como hecho; o (según target) no conecta con los ejes obligatorios de ese target.

SALIDA: responde EXCLUSIVAMENTE con un JSON válido que cumpla el esquema indicado en el mensaje de usuario. No incluyas markdown, ni texto fuera del JSON, ni bloques de código. La suma de puntos de la rúbrica equivale a 100; no cambies los pesos. Para cada criterio entrega score, max_score, evidencia del transcript, comentario y recomendación.

El feedback debe ser claro, ejecutivo y accionable, sin sonar condescendiente. Todo en español de Colombia.`;

// The exact JSON contract the model must return (from the spec).
const OUTPUT_SCHEMA = `{
  "session_id": "string",
  "target_mode": "string",
  "overall_score": 0,
  "readiness_level": "bajo | medio | alto | sobresaliente",
  "one_line_diagnosis": "string",
  "executive_summary": "string (máx 90 palabras)",
  "duration": {
    "seconds": 0,
    "formatted": "0:00",
    "ideal_seconds": 90,
    "max_seconds": 180,
    "status": "ideal | aceptable | largo | fuera_de_rango",
    "comment": "string"
  },
  "detected_requirements": {
    "mentioned_sas": true,
    "used_numbers": true,
    "numbers_detected": [],
    "has_cta": true,
    "aligned_to_playbook": true
  },
  "speech_metrics": {
    "word_count": 0,
    "words_per_minute": 0,
    "filler_words_total": 0,
    "top_filler_words": [],
    "repetition_count": 0,
    "top_repetitions": [],
    "long_pauses_count": 0,
    "comment": "string"
  },
  "criteria_scores": [
    { "criterion_id": "string", "criterion_name": "string", "score": 0, "max_score": 0, "evidence": "string", "comment": "string", "recommendation": "string" }
  ],
  "strengths": ["string"],
  "improvement_areas": ["string"],
  "critical_flags": [ { "flag": "string", "severity": "low | medium | high", "comment": "string" } ],
  "missed_opportunities": ["string"],
  "best_line_from_user": "string",
  "weakest_line_from_user": "string",
  "recommended_pitch_90_seconds": "string",
  "recommended_pitch_45_seconds": "string",
  "recommended_cta": "string",
  "next_training_focus": ["string"],
  "coach_feedback": "string"
}`;

function transcriptToText(transcript: TranscriptTurn[]): {
  full: string;
  userOnly: string;
} {
  const full = transcript
    .map((t) => `${t.role === "user" ? "SANDRA" : "ENTREVISTADOR"}: ${t.text}`)
    .join("\n");
  const userOnly = transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join("\n");
  return { full, userOnly };
}

export function buildEvaluatorUserMessage(params: {
  sessionId: string;
  target: TargetMode;
  transcript: TranscriptTurn[];
  durationSeconds: number;
  metrics: SpeechMetrics;
}): string {
  const { sessionId, target, transcript, durationSeconds, metrics } = params;
  const rubric = getRubric(target);
  const profile = getProfile(target);
  const { full, userOnly } = transcriptToText(transcript);

  const rubricInputs = {
    session_id: sessionId,
    target_mode: target,
    rubric,
    duration_seconds: durationSeconds,
    metrics: {
      word_count: metrics.word_count,
      words_per_minute: metrics.words_per_minute,
      filler_words: {
        total: metrics.filler_words_total,
        items: metrics.filler_words_items,
      },
      repetitions: {
        total: metrics.repetition_count,
        items: metrics.repetition_items,
      },
      mentioned_sas: metrics.mentioned_sas,
      used_numbers: metrics.used_numbers,
      numbers_detected: metrics.numbers_detected,
      has_cta: metrics.has_cta,
      long_pauses_count: metrics.long_pauses_count,
    },
  };

  return `PERFIL DEL TARGET (contexto, no suplantar):
${profile}

CONTEXTO PLAYBOOK SAS:
${PLAYBOOK_PRINCIPLES}

${PLAYBOOK_KEY_FIGURES}

${PLAYBOOK_COLOMBIA_FIGURES}

RÚBRICA Y MÉTRICAS (JSON de entrada):
${JSON.stringify(rubricInputs, null, 2)}

TRANSCRIPT COMPLETO (entrevistador + Sandra):
${full}

SOLO LO DICHO POR SANDRA:
${userOnly}

Evalúa con la rúbrica del target "${target}". Calcula score por criterio (usando exactamente los criterion_id y puntos de la rúbrica), score total ponderado sobre 100, nivel de preparación y feedback accionable.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
${OUTPUT_SCHEMA}`;
}
