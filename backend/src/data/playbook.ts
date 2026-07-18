// Condensed SAS playbook context. Precomputed (not a live RAG call) so it can be
// injected into the interviewer agent prompt and the evaluator without adding
// latency to the conversation. Distilled from the Playbook de Vocería SAS 2026.

export const PLAYBOOK_PRINCIPLES = `PRINCIPIOS NARRATIVOS SAS (para evaluar alineación):
- SAS es la compañía global líder en IA y analítica avanzada que transforma información en decisiones confiables.
- Enfoque Industry-First: se abre por el DOLOR de la industria, no por la tecnología.
- El vocero traduce capacidad técnica en resultado de negocio: desafío real → información → insight → decisión → impacto verificable.
- Conectar siempre con tres dimensiones: mitigación de riesgo, productividad y valor humano.
- Trust como capacidad operativa: datos confiables, modelos explicables, decisiones auditables, gobernanza integrada, trazabilidad y supervisión humana (human-in-the-loop).
- IA generativa abrió la conversación; la IA agéntica confiable (con reglas, gobernanza y supervisión) define el siguiente capítulo.
- Las cifras son soporte, no el eje del discurso. Estructura local sugerida: dato nacional + dolor de industria + implicación para la organización + rol de SAS.
- Simplificar sin perder rigurosidad. No prometer "fraude cero" ni resultados garantizados sin baseline.
- 50 años como punto de partida para liderar lo que viene, no como nostalgia/legacy.`;

export const PLAYBOOK_KEY_FIGURES = `CIFRAS CLAVE SAS (para respaldar, usar con moderación):
- +50 años de innovación en analítica; racha ininterrumpida de rentabilidad (1976–2026).
- USD 1.000M invertidos en los últimos 3 años en desarrollo de productos basados en IA.
- USD 3.000M+ en ventas anuales globales; clientes/aliados en +150 países; +1.400 partners en 96 países.
- SAS Viya: hasta 4,6x más productividad y hasta 30x más velocidad vs. alternativas tradicionales; 86% del ciclo de datos e IA al alcance de perfiles de negocio.
- Líder en Gartner Magic Quadrant 2026 de Decision Intelligence Platforms (SAS Viya); 36 evaluaciones de analistas clasificaron a SAS como líder en 2025.
- +1.600 bancos en 92 países usan SAS, incluido +90% de los 100 bancos más grandes del mundo.`;

export const PLAYBOOK_COLOMBIA_FIGURES = `CIFRAS DE CONTEXTO COLOMBIA (banca/pagos, para dato nacional):
- Canales no presenciales = 82,8% de las operaciones del sistema financiero (4T25); 68,7% del monto transado.
- 81% de los establecimientos de crédito ya usa IA en sus procesos (2025).
- Acceso a productos financieros 96,4%; uso efectivo 85%; acceso a crédito 36,1% (sep. 2025).
- Bre-B: pagos y transferencias inmediatas interoperables 24/7 entre entidades.
- Colombia: 2º país más atacado de LatAm en ciberataques (17% de intentos, 2024); sectores financiero, salud y energía los más afectados.
- CONPES 4144: hoja de ruta nacional de IA, +100 acciones a 2030, inversión de $479.000M.`;

// Short summary variable injected as {{playbook_summary}} into agents.
export const PLAYBOOK_SUMMARY = `${PLAYBOOK_PRINCIPLES}

${PLAYBOOK_KEY_FIGURES}`;
