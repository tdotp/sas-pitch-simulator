// Evaluation rubrics — ported verbatim from rubricas_sas.json.
// The evaluator prompt receives the rubric for the active target; weights sum to 100.

import type { RubricKey, TargetMode } from "../types.js";

export interface RubricCriterion {
  points: number;
  description: string;
}

export interface Rubric {
  name: string;
  max_score: number;
  criteria: Record<string, RubricCriterion>;
  observable_rules: string[];
  duration_policy?: {
    ideal_seconds: number;
    max_seconds: number;
    scoring: Record<string, number>;
  };
  must_reward?: string[];
  must_penalize?: string[];
}

export const RUBRICS: Record<RubricKey, Rubric> = {
  generic: {
    name: "Rúbrica genérica C-level",
    max_score: 100,
    criteria: {
      message_clarity: {
        points: 20,
        description:
          "El pitch es directo, comprensible, ejecutivo y evita vueltas innecesarias.",
      },
      business_relevance: {
        points: 15,
        description:
          "Conecta SAS con un problema real de negocio, riesgo, eficiencia, cliente o toma de decisiones.",
      },
      playbook_alignment: {
        points: 20,
        description:
          "Está alineado con narrativa SAS: IA confiable, analítica avanzada, gobernanza, criterio humano, decisiones confiables e impacto por industria.",
      },
      use_of_evidence: {
        points: 15,
        description:
          "Incluye al menos una cifra o evidencia concreta y la conecta con una implicación de negocio.",
      },
      sas_positioning: {
        points: 10,
        description:
          "Menciona SAS de forma natural y diferenciada, sin sonar a venta genérica.",
      },
      call_to_action: {
        points: 10,
        description:
          "Cierra con un siguiente paso concreto, realista y accionable.",
      },
      duration_control: {
        points: 5,
        description:
          "Idealmente dura 90 segundos o menos; máximo aceptable 180 segundos.",
      },
      verbal_fluency: {
        points: 5,
        description:
          "Evita muletillas excesivas, repeticiones, contradicciones o pérdida de foco.",
      },
    },
    observable_rules: [
      "incluye al menos una cifra",
      "menciona SAS",
      "incluye un call to action",
      "no supera 180 segundos",
      "abre con dolor de negocio, no con herramienta",
      "evita buzzwords vacíos",
      "no promete resultados sin baseline",
      "no usa información no verificable",
    ],
    duration_policy: {
      ideal_seconds: 90,
      max_seconds: 180,
      scoring: { lte_90: 100, lte_120: 80, lte_150: 60, lte_180: 40, gt_180: 0 },
    },
  },

  davivienda_javier_suarez: {
    name: "Rúbrica CEO Davivienda / Javier José Suárez",
    max_score: 100,
    criteria: {
      strategic_context: {
        points: 15,
        description:
          "Entiende la agenda Scotiabank, Davivienda Group, DAVIbank e integración regional.",
      },
      daviplata_relevance: {
        points: 10,
        description:
          "Conecta DaviPlata con rentabilidad, crédito, recurrencia, fraude o collections; no la trata solo como wallet.",
      },
      payments_fraud_depth: {
        points: 10,
        description:
          "Aterriza pagos, Bre-B, ePayco, adquirencia, fraude transaccional y falsos positivos.",
      },
      risk_governance: {
        points: 15,
        description:
          "Habla de gobierno de modelos, monitoreo, líneas de defensa, drift, auditoría y regulación.",
      },
      use_of_public_data: {
        points: 10,
        description:
          "Usa cifras públicas correctas y recientes sobre Davivienda, DaviPlata, digitalización, clientes, cartera, pagos o sector financiero.",
      },
      implementation_logic: {
        points: 10,
        description:
          "Propone quick wins, secuencia de despliegue y convivencia con capacidades existentes. Evita big bang.",
      },
      sas_differentiation: {
        points: 10,
        description:
          "Explica por qué SAS aporta más que un modelo aislado, hyperscaler o desarrollo interno: decisioning, gobierno, analítica y trazabilidad.",
      },
      economic_impact: {
        points: 10,
        description:
          "Conecta la propuesta con pérdida evitada, provisión, conversión, eficiencia, aprobación, capital o rentabilidad ajustada por riesgo.",
      },
      return_questions: {
        points: 5,
        description:
          "Formula preguntas inteligentes para descubrir sponsor, KPI base, dolor prioritario u ownership.",
      },
      credibility: {
        points: 5,
        description:
          "Evita especular, no atribuye preferencias privadas y reconoce límites de datos o implementación.",
      },
    },
    observable_rules: [
      "menciona Scotiabank, Davivienda Group o integración regional temprano",
      "reconoce que existen Banco Davivienda y Davivienda Group cuando sea relevante",
      "conecta DaviPlata con rentabilidad, crédito, recurrencia, fraude o collections",
      "no habla de IA sin mencionar gobierno, monitoreo o trazabilidad",
      "si habla de fraude, menciona falsos positivos o fricción",
      "si habla de pagos, menciona tiempo real o interoperabilidad",
      "pregunta por métricas base antes de prometer impacto",
      "evita prometer reemplazo total del stack actual",
      "usa al menos una cifra pública verificable",
      "vincula la propuesta con P&L, riesgo, capital o eficiencia",
      "no atribuye opiniones privadas a Javier Suárez",
      "mantiene tono ejecutivo y técnico",
    ],
    must_reward: [
      "quick wins de 90 a 180 días",
      "gobierno multi-país",
      "fraude evitado y falsos positivos",
      "DaviPlata rentable",
      "ePayco y merchant risk",
      "orquestación de decisiones",
    ],
    must_penalize: [
      "transformación digital genérica",
      "IA sin gobierno",
      "prometer automatización sin supervisión",
      "no conectar con integración regional",
      "no incluir cifra",
      "no incluir CTA",
    ],
  },

  grupo_aval_maria_lorena: {
    name: "Rúbrica CEO Grupo Aval / María Lorena Gutiérrez",
    max_score: 100,
    criteria: {
      holding_logic: {
        points: 15,
        description:
          "Entiende la lógica de holding, sinergias y mejores prácticas entre entidades.",
      },
      payments_relevance: {
        points: 15,
        description:
          "Conecta con pagos interoperables, GOU Payments, Bre-B, QR, WhatsApp o ecosistema de pagos.",
      },
      cyber_maturity: {
        points: 10,
        description:
          "Habla de ciberseguridad, SOC, CSIRT, ciberfraude o riesgo de terceros con madurez técnica y ejecutiva.",
      },
      open_finance_governance: {
        points: 10,
        description:
          "Aterriza open finance y gobierno del dato: consentimiento, seguridad, trazabilidad, protección al consumidor y regulación.",
      },
      use_of_public_data: {
        points: 10,
        description:
          "Usa cifras públicas útiles sobre Grupo Aval, pagos, clientes, cartera, depósitos, Bre-B, sector financiero o inclusión.",
      },
      profitability_efficiency: {
        points: 15,
        description:
          "Conecta la propuesta con rentabilidad, eficiencia, pérdida evitada, reducción de revisión manual, calidad de cartera o costo operativo.",
      },
      cross_entity_scalability: {
        points: 10,
        description:
          "Explica cómo la capacidad escala entre entidades sin prometer uniformidad total inmediata.",
      },
      risk_acknowledgement: {
        points: 5,
        description:
          "Hace visibles riesgos y mitigantes: regulación, consumidor, terceros, datos, sesgo, deriva o centralización excesiva.",
      },
      return_questions: {
        points: 5,
        description:
          "Formula preguntas de retorno de nivel holding: sponsor, entidad ancla, dominio prioritario, KPI corporativo.",
      },
      credibility: {
        points: 5,
        description:
          "Mantiene prudencia, no sobrepromete y no atribuye preferencias privadas.",
      },
    },
    observable_rules: [
      "menciona lógica de holding o sinergias",
      "si habla de pagos, menciona interoperabilidad o tiempo real",
      "si habla de IA, menciona gobierno, monitoreo o trazabilidad",
      "si habla de open finance, menciona consentimiento y seguridad",
      "no presenta un caso exclusivo para una sola entidad sin explicar réplica",
      "incluye al menos una métrica de ROI, eficiencia o pérdida evitada",
      "reconoce sensibilidad regulatoria y de consumidor",
      "evita lenguaje anti-fintech o anti-ecosistema",
      "si propone centralización, delimita qué se centraliza y qué no",
      "usa una cifra pública actual del grupo o del sector",
      "hace una pregunta sobre sponsor corporativo o entidad ancla",
      "no promete uniformidad total inmediata entre bancos",
      "no vende solo tecnología; vende operating model",
      "traduce beneficio a holding y a entidad específica cuando aplique",
    ],
    must_reward: [
      "capacidad reusable para el grupo",
      "pagos interoperables con control",
      "ciberfraude y riesgo de terceros",
      "ROI defendible",
      "gobierno de IA a nivel grupo",
      "centralización matizada: estándares sí, ejecución no necesariamente",
    ],
    must_penalize: [
      "caso local sin lógica de holding",
      "IA como hype",
      "centralización total sin matices",
      "claims regulatorios ingenuos",
      "lenguaje anti-ecosistema",
      "no incluir cifra",
      "no incluir CTA",
    ],
  },
};

// Map the app-facing target mode to the rubric key.
export const TARGET_TO_RUBRIC: Record<TargetMode, RubricKey> = {
  generic: "generic",
  davivienda: "davivienda_javier_suarez",
  grupo_aval: "grupo_aval_maria_lorena",
};

export function getRubric(target: TargetMode): Rubric {
  return RUBRICS[TARGET_TO_RUBRIC[target]];
}
