// GENERIC interviewer prompt builder. This is the ENGINE half of what
// used to be backend/src/data/prompts.ts — it assembles a system prompt
// and first message from a ResolvedScenarioConfig, with ZERO knowledge of
// which client or scenario it's building for. No `if (scenario.id ===
// ...)`, no client names, nothing imported from a specific config
// package. If this file ever needs to special-case an organization or
// scenario id, that's a sign content belongs in config, not here.

import type { ResolvedScenarioConfig } from "../engine-config/schema.js";

// Truly universal conversational-agent operating rules — apply to ANY
// interviewer persona, for ANY client. Tone/register/language belongs in
// InterviewerProfile.tone (config), not here.
const ENGINE_COMMON_RULES = `REGLAS DE CONVERSACIÓN (aplican siempre, sin importar el escenario):
- Una pregunta por turno. No des discursos largos. Respuestas cortas para reducir latencia.
- No evalúes en detalle durante la conversación. No entregues el reporte final en voz.
- No interrumpas a quien practica salvo que se salga por completo del ejercicio.
- No digas que mides emociones ni afirmes estados internos de la persona.
- No inventes cifras ni uses información no verificada. No atribuyas opiniones privadas a personas reales.`;

// The mandatory N-follow-up-question flow is ENGINE behavior (always
// anchor question 2+ to the previous answer, always close after the last
// one) — only the COUNT and the candidate question banks are config
// (InterviewerProfile.followUpBehavior).
function buildFollowUpInstructions(behavior: ResolvedScenarioConfig["interviewerProfile"]["followUpBehavior"]): string {
  const { requiredCount, specificQuestions, sharedQuestions } = behavior;
  if (requiredCount === 0) {
    return "No hagas preguntas de seguimiento obligatorias — solo escucha el pitch y cierra.";
  }

  const pool = [...specificQuestions, ...sharedQuestions];
  const list = pool.map((q) => `- "${q}"`).join("\n");
  const countWord = requiredCount === 1 ? "UNA" : `${requiredCount}`;

  return `FLUJO DE REPREGUNTAS (exactamente ${countWord}, en este orden):

PREGUNTA 1 (obligatoria, textual de la lista):
En cuanto termine el pitch inicial, haz UNA pregunta concreta tomada literalmente de esta lista — elige la que mejor aplique según lo que se dijo. Es obligatorio hacerla; no la omitas y no inventes una pregunta distinta a estas:
${list}

${
  requiredCount > 1
    ? `PREGUNTAS SIGUIENTES (de la misma lista, ancladas a la respuesta anterior):
En cuanto respondan cada pregunta, haz la siguiente — elige otra de la lista de arriba — pero antes de plantearla, engánchala explícitamente con algo concreto que se acaba de decir en la respuesta anterior. No la presentes como una pregunta suelta y desconectada.

CIERRE:
En cuanto respondan la última pregunta, cierra la conversación de inmediato con el mensaje de cierre. No hagas una pregunta adicional ni sigas conversando después.`
    : `CIERRE:
En cuanto respondan la Pregunta 1, cierra la conversación de inmediato con el mensaje de cierre.`
}`;
}

function buildContentBlock(contentSources: ResolvedScenarioConfig["contentSources"]): string {
  if (contentSources.length === 0) return "";
  return contentSources.map((c) => `${c.title.toUpperCase()}:\n${c.body}`).join("\n\n");
}

export interface InterviewerPrompt {
  systemPrompt: string;
  firstMessage: string;
}

export function buildInterviewerPrompt(resolved: ResolvedScenarioConfig): InterviewerPrompt {
  const { scenario, interviewerProfile, contentSources } = resolved;

  const systemPrompt = [
    interviewerProfile.persona,
    `REGISTRO Y TONO: ${interviewerProfile.tone}`,
    interviewerProfile.questioningBehavior,
    scenario.openingContext,
    ENGINE_COMMON_RULES,
    buildFollowUpInstructions(interviewerProfile.followUpBehavior),
    `CIERRE (di esto y termina, no sigas hablando después):\n"${scenario.closingMessage}"`,
    buildContentBlock(contentSources),
  ]
    .filter(Boolean)
    .join("\n\n");

  return { systemPrompt, firstMessage: scenario.firstMessage };
}
