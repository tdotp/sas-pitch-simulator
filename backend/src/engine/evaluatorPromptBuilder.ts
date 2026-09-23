// GENERIC evaluator prompt builder — the ENGINE half of what used to be
// backend/src/data/evaluatorPrompt.ts. Consumes a resolved
// EvaluationFramework; never imports a fixed rubric (no
// rubricas_sas.json equivalent lives here or anywhere in engine/*). If
// this file ever needs a client/scenario id to decide what to evaluate,
// that's a bug — the resolved framework must already carry everything.

import type { ResolvedScenarioConfig } from "../engine-config/schema.js";
import type { SpeechMetrics, TranscriptTurn } from "../types.js";

// Universal evaluator behavior — applies to ANY EvaluationFramework, for
// ANY client. Framework-specific nuance (e.g. "don't attribute private
// opinions to Javier Suárez") comes from
// EvaluationFramework.evaluationInstructions (config), appended below.
export const ENGINE_EVALUATOR_SYSTEM_PROMPT = `Eres un evaluador experto en comunicación ejecutiva y vocería corporativa. Evalúas un pitch usando un framework de evaluación estructurado que se te entrega — nunca uno que ya conozcas de memoria.

No actúas como entrevistador ni continúas la conversación. Analizas el transcript, las métricas y el framework de evaluación, y entregas un JSON completo.

REGLAS GENERALES:
- Evalúa estrictamente el desempeño observable en el transcript. No infieras emociones internas ni diagnostiques nerviosismo o estados psicológicos. Puedes hablar de señales comunicacionales observables (claridad, ritmo, repeticiones, pausas, falta de foco).
- No inventes cifras ni atribuyas intenciones privadas a personas reales.
- Si falta evidencia, dilo explícitamente.
- Distingue hechos observables, inferencias razonables y recomendaciones.
- El framework puede declarar una lista de "requirements" (framework.requirements en el JSON de entrada), cada uno con id y description. Devuelve exactamente un elemento en detected_requirements por cada requirement declarado (mismo id), con detected=true/false y evidence citando el transcript. NO incluyas "description" en tu respuesta — el sistema la completa automáticamente desde el framework después. Si el framework no declara requirements, detected_requirements es un array vacío.

SALIDA: responde EXCLUSIVAMENTE con un JSON válido que cumpla el esquema indicado en el mensaje de usuario. No incluyas markdown, ni texto fuera del JSON, ni bloques de código. La suma de puntos del framework equivale a max_score; no cambies los pesos. Para cada criterio entrega score, max_score, evidencia del transcript, comentario y recomendación.

El feedback debe ser claro, ejecutivo y accionable, sin sonar condescendiente. Todo en español de Colombia.`;

// The exact JSON contract the model must return — engine-level, stable
// across every framework (criteria are a list, not fixed fields, so this
// never needs to change per client).
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
  "detected_requirements": [
    { "id": "string (uno de framework.requirements[].id, uno por cada requirement declarado)", "detected": true, "evidence": "string (cita textual del transcript, o vacío si no se detectó)" }
  ],
  "speech_metrics": {
    "word_count": 0,
    "words_per_minute": 0,
    "filler_words_total": 0,
    "top_filler_words": [],
    "repetition_count": 0,
    "top_repetitions": [],
    "long_pauses_count": 0,
    "used_numbers": true,
    "numbers_detected": [],
    "has_cta": true,
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

// Phase 5 fix (PASS_WITH_FIXES): neutral role labels, not a hardcoded
// person name — this function must serialize the same way regardless of
// which client/organization's session it's building a prompt for.
function transcriptToText(transcript: TranscriptTurn[]): { full: string; userOnly: string } {
  const full = transcript
    .map((t) => `${t.role === "user" ? "VOCERO" : "ENTREVISTADOR"}: ${t.text}`)
    .join("\n");
  const userOnly = transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join("\n");
  return { full, userOnly };
}

export function buildEvaluatorSystemPrompt(resolved: ResolvedScenarioConfig): string {
  return `${ENGINE_EVALUATOR_SYSTEM_PROMPT}

INSTRUCCIONES ESPECÍFICAS DE ESTE FRAMEWORK:
${resolved.evaluationFramework.evaluationInstructions}`;
}

export function buildEvaluatorUserMessage(params: {
  sessionId: string;
  resolved: ResolvedScenarioConfig;
  transcript: TranscriptTurn[];
  durationSeconds: number;
  metrics: SpeechMetrics;
}): string {
  const { sessionId, resolved, transcript, durationSeconds, metrics } = params;
  const { scenario, evaluationFramework, contentSources } = resolved;
  const { full, userOnly } = transcriptToText(transcript);

  const frameworkInputs = {
    session_id: sessionId,
    scenario_id: scenario.id,
    framework: {
      id: evaluationFramework.id,
      name: evaluationFramework.name,
      max_score: evaluationFramework.maxScore,
      criteria: evaluationFramework.criteria,
      requirements: evaluationFramework.requirements,
      observable_rules: evaluationFramework.observableRules,
      duration_policy: evaluationFramework.durationPolicy,
      must_reward: evaluationFramework.mustReward,
      must_penalize: evaluationFramework.mustPenalize,
    },
    duration_seconds: durationSeconds,
    metrics: {
      word_count: metrics.word_count,
      words_per_minute: metrics.words_per_minute,
      filler_words: { total: metrics.filler_words_total, items: metrics.filler_words_items },
      repetitions: { total: metrics.repetition_count, items: metrics.repetition_items },
      used_numbers: metrics.used_numbers,
      numbers_detected: metrics.numbers_detected,
      has_cta: metrics.has_cta,
      long_pauses_count: metrics.long_pauses_count,
    },
  };

  const contentBlock =
    contentSources.length > 0
      ? contentSources.map((c) => `${c.title.toUpperCase()}:\n${c.body}`).join("\n\n")
      : "(sin contenido adicional configurado para este escenario)";

  return `CONTEXTO DEL ESCENARIO "${scenario.name}":
${scenario.description}

CONTENIDO DE REFERENCIA:
${contentBlock}

FRAMEWORK DE EVALUACIÓN Y MÉTRICAS (JSON de entrada):
${JSON.stringify(frameworkInputs, null, 2)}

TRANSCRIPT COMPLETO (entrevistador + persona evaluada):
${full}

SOLO LO DICHO POR LA PERSONA EVALUADA:
${userOnly}

Evalúa con el framework "${evaluationFramework.id}". Calcula score por criterio (usando exactamente los criterion_id y pesos del framework), score total ponderado sobre ${evaluationFramework.maxScore}, nivel de preparación y feedback accionable.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
${OUTPUT_SCHEMA}`;
}
