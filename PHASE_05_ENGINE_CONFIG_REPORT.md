# PHASE_05_ENGINE_CONFIG_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 5 de 15 — ENGINE vs CONFIG
**Fecha:** 22 de septiembre de 2026
**Commit base aprobado (Fase 4, cerrada):** `e43a748c4c86293eb4e091144797796c170af12f`
**Código de esta fase:** `25700d85f4c4a615672ad5407c87831ef5519ae5`
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado.**

---

## WHAT_CHANGED

Se separó por completo el motor genérico de entrenamiento (`backend/src/engine/`, `backend/src/engine-config/`) de todo el contenido específico de SAS (prompts, rúbricas, perfiles, playbook, voces, timings, mapeos de escenario), que ahora vive como **datos versionados en paquetes de configuración**, nunca en código.

- **Eliminados** `backend/src/data/{prompts,rubrics,profiles,playbook,evaluatorPrompt}.ts` — los 5 módulos que contenían el `switch`/branching por cliente (`if (target === "davivienda")`, `Record<TargetMode, ...>`) y el texto hardcodeado de SAS.
- **Migrado** todo ese contenido, textualmente (sin reescribirlo), a dos paquetes de configuración en `backend/config-packages/`: `sas-colombia` (3 escenarios reales: `generic`, `davivienda`, `grupo_aval`) y `acme-demo` (1 escenario ficticio, de demostración).
- **Nuevo** `backend/src/engine-config/` — el dominio de configuración: schemas Zod (`schema.ts`), loader con validación estructural + semántica (`loader.ts`), y el resolver genérico `resolveScenarioConfig(organizationId, scenarioId)` (`resolver.ts`).
- **Nuevo** `backend/src/engine/` — el motor genérico: `promptBuilder.ts` (arma el prompt del entrevistador desde config resuelta) y `evaluatorPromptBuilder.ts` (arma el prompt del evaluador desde config resuelta). Ninguno de los dos conoce SAS, Davivienda, Grupo Aval ni ningún cliente.
- `services/elevenlabs.ts` (`getSignedUrl`) y `services/evaluator.ts` (`evaluatePitch`) ya no reciben `TargetMode` — reciben `ResolvedScenarioConfig`.
- `routes.ts`: `/session/start` resuelve `scenarioId` (bajo el campo de wire `target_mode`, ver `TARGET_MODE_MIGRATION`) contra la organización del caller; `/session/end` re-resuelve la MISMA config desde lo persistido en la sesión, nunca desde el body.
- `SessionRecord` gana `scenario_id` como campo canónico; `target_mode` queda como espejo de compatibilidad deprecado.
- `backend/Dockerfile` corregido: sin este cambio, la imagen de producción no habría incluido `config-packages/` y el motor habría fallado en el VPS aunque funcionara en local (detectado y corregido en esta misma fase, ver `MIGRATION_NOTES`).

No se tocó: el modelo Organization/Membership/Role/RBAC (Fases 2-3), el session lifecycle (Fase 4), ni el frontend (cero archivos modificados — ver `FRONTEND_COMPATIBILITY`).

---

## OLD_HARDCODED_MODEL

Lo que existía antes de esta fase, todo en TypeScript, todo importado directamente:

| Módulo | Qué hardcodeaba | Mecanismo |
|---|---|---|
| `data/prompts.ts` | 3 funciones (`genericPrompt`, `daviviendaPrompt`, `grupoAvalPrompt`) con el prompt completo de cada escenario en un template string | `switch (target) { case "davivienda": ... }` |
| `data/rubrics.ts` | 3 rúbricas completas (criterios, pesos, reglas) | `Record<RubricKey, Rubric>` + `TARGET_TO_RUBRIC: Record<TargetMode, RubricKey>` |
| `data/profiles.ts` | 3 perfiles de "target" (Suárez, Gutiérrez, genérico) | `Record<TargetMode, string>` |
| `data/playbook.ts` | El playbook SAS completo (principios, cifras) | Constantes exportadas, importadas directo por `prompts.ts` y `evaluatorPrompt.ts` |
| `data/evaluatorPrompt.ts` | El prompt del evaluador, con "SAS" en el texto universal | Importaba `rubrics.ts` + `profiles.ts` + `playbook.ts` directamente |
| `types.ts` | `TargetMode = "generic" \| "davivienda" \| "grupo_aval"` | Union type cerrado, propagado a `SessionRecord`, `StartSessionRequest`, `EvaluationResult` |
| `routes.ts` | `VALID_TARGETS` array + validación `includes()` | — |
| `services/elevenlabs.ts` | Selección de voz por target (`if (target === "davivienda") return v.male`) | `if/else` |
| `frontend/src/config.ts` | `TARGETS` (los mismos 3, con labels/colores de UI) | Array literal (sin cambios en esta fase — ver `FRONTEND_COMPATIBILITY`) |

Agregar un cuarto cliente habría exigido: un cuarto valor en `TargetMode`, una cuarta función de prompt, una cuarta entrada en cada `Record`, tocar `VALID_TARGETS`, y (probablemente) una cuarta rama en `elevenlabs.ts`. Exactamente lo que el prompt de esta fase pidió eliminar.

---

## NEW_DOMAIN_MODEL

```
Organization (Fase 2, sin cambios)
    ↓
ClientConfig            — defaults mínimos de la organización
    ↓
Scenario                — una experiencia de entrenamiento concreta
    ├── InterviewerProfile   — cómo se comporta el entrevistador
    ├── EvaluationFramework  — con qué rúbrica se evalúa
    └── ContentSource[]      — conocimiento/contexto inyectado
```

```
Generic Engine (backend/src/engine/*)
    +
ResolvedScenarioConfig (backend/src/engine-config/resolver.ts)
    =
Training Session
```

`resolveScenarioConfig({ organizationId, scenarioId })` es la única puerta de entrada. Todo lo que hay después (`routes.ts`, `elevenlabs.ts`, `evaluator.ts`) consume exclusivamente el `ResolvedScenarioConfig` que devuelve — nunca vuelve a mirar `organizationId` ni `scenarioId` como strings para decidir nada.

---

## CONFIG_PACKAGE_STRUCTURE

```
backend/config-packages/
  sas-colombia/
    v1/
      manifest.json
      client.json
      interviewer-profiles/
        c-level-generic.json
        c-level-davivienda.json
        c-level-grupo-aval.json
      scenarios/
        generic.json
        davivienda.json
        grupo_aval.json
      evaluation-frameworks/
        generic-v1.json
        davivienda-v1.json
        grupo-aval-v1.json
      content/
        playbook-sas.json
        colombia-context.json
        profile-davivienda.json
        profile-grupo-aval.json
  acme-demo/
    v1/
      manifest.json
      client.json
      interviewer-profiles/press-generic.json
      scenarios/generic.json
      evaluation-frameworks/press-generic-v1.json
      content/acme-facts.json
```

**Desviación deliberada de la estructura de referencia del prompt:** el contenido de cada `ContentSource` (`content/*.md` en el ejemplo del prompt) se guarda como un campo `body` dentro de un `.json`, no como un `.md` separado referenciado por metadata. Un solo formato de archivo por carpeta simplifica el loader (una sola rutina de lectura+parseo para las 4 carpetas de entidades) sin perder nada del modelo — el prompt explícitamente permitió esto ("no es una obligación literal si una estructura mejor encaja"). El `manifest.json` como punto de entrada sí se mantuvo literal.

---

## CLIENT_CONFIG_MODEL

```ts
interface ClientConfig {
  organizationId: string;
  defaultLanguage: string;       // default "es"
  defaultScenarioId?: string;
  settings: Record<string, unknown>;
}
```

Deliberadamente mínimo — sin mega-string de prompt, sin rúbrica, sin contenido. `sas-colombia/v1/client.json` y `acme-demo/v1/client.json` son de 5 líneas cada uno.

---

## INTERVIEWER_PROFILE_MODEL

```ts
interface InterviewerProfile {
  id: string;
  name: string;
  persona: string;               // texto libre, quién es/qué rechaza
  tone: string;                  // registro/tono corto
  questioningBehavior: string;   // cómo presiona durante el pitch
  followUpBehavior: {
    requiredCount: number;       // ENGINE aplica este número genéricamente
    specificQuestions: string[];
    sharedQuestions: string[];
  };
  voice: { slot: "male" | "female" | "random" };
}
```

Sin lógica de código, tal como pidió el prompt — es puro dato. El **conteo** de repreguntas obligatorias (antes hardcodeado a "exactamente DOS" en `buildMandatoryFollowUp`) ahora es config (`requiredCount`); lo que sigue siendo motor es la REGLA de cómo se construye el flujo (anclar cada pregunta a la respuesta anterior, cerrar después de la última) — ver `engine/promptBuilder.ts`.

`voice.slot` es simbólico (`"male"/"female"/"random"`), nunca un voice id real de ElevenLabs — esos siguen en variables de entorno (`ELEVEN_VOICE_MALE`, etc.), no en el paquete de contenido. Así un paquete de configuración puede eventualmente vivir en Firestore, editable por alguien no-técnico, sin que nunca cargue un secreto/id de proveedor.

---

## SCENARIO_MODEL

```ts
interface Scenario {
  id: string;
  name: string;
  description: string;
  interviewerProfileId: string;   // referencia, no duplicación
  evaluationFrameworkId: string;  // referencia, no duplicación
  contentSourceIds: string[];     // referencias, no duplicación
  timing: { idealSeconds: number; maxSeconds: number };
  firstMessage: string;
  openingContext: string;         // qué debe demostrar la persona en ESTE escenario
  closingMessage: string;
}
```

Composición por referencia, tal como pidió el prompt — `davivienda.json` no repite el playbook SAS ni el perfil del target, solo apunta a `contentSourceIds: ["playbook-sas", "profile-davivienda"]`.

---

## EVALUATION_FRAMEWORK_MODEL

```ts
interface EvaluationFramework {
  id: string;
  name: string;
  maxScore: number;               // default 100
  criteria: Array<{ id, name, weight, description }>;
  observableRules: string[];
  durationPolicy?: { idealSeconds, maxSeconds, scoring? };
  mustReward: string[];
  mustPenalize: string[];
  evaluationInstructions: string; // nuance específica del framework
}
```

`evaluator.ts` ya **no importa `rubricas_sas.json`** ni ningún equivalente — recibe el framework ya resuelto dentro de `ResolvedScenarioConfig`.

**WEIGHTS_SUM_RULE (documentada explícitamente, no inventada):** los criterios de un framework deben sumar exactamente `maxScore`. Esta regla existe porque es literalmente cómo ya funcionaban las 3 rúbricas reales del producto antes de esta fase (generic: 20+15+20+15+10+10+5+5=100; Davivienda: 15+10+10+15+10+10+10+10+5+5=100; Grupo Aval: 15+15+10+10+10+15+10+5+5+5=100) — Fase 5 solo la hizo explícita y la convirtió en una validación Zod (`EvaluationFrameworkSchema`'s `superRefine`), no cambió el modelo de evaluación real.

---

## CONTENT_SOURCE_MODEL

```ts
interface ContentSource {
  id: string;
  type: "company_context" | "key_messages" | "facts" | "restrictions" | "faq" | "playbook";
  title: string;
  body: string; // texto libre, inyectado tal cual en los prompts
}
```

Sin vector DB, sin RAG — exactamente lo que pidió el prompt ("el volumen actual puede resolverse cargando contenido estructurado"). Los 5 content sources reales (`playbook-sas`, `colombia-context`, `profile-davivienda`, `profile-grupo-aval`, `acme-facts`) sencillamente se concatenan en el prompt final. Si el volumen creciera lo suficiente para que esto deje de ser proporcional, RAG sería una decisión de una fase posterior basada en necesidad real — no se construyó nada de eso aquí.

---

## CONFIG_RESOLUTION_FLOW

```
routes.ts (/session/start)
  → resolveScenarioConfig({ organizationId: req.appContext.organizationId, scenarioId })
      → FileConfigPackageLoader.loadPackage(organizationId)
          1. lee manifest.json + client.json (Zod)
          2. lee cada .json de interviewer-profiles/, scenarios/,
             evaluation-frameworks/, content/ (Zod, por archivo)
          3. si CUALQUIERA falla estructuralmente → { valid: false, errors }
          4. si todo parsea → validatePackageReferences(pkg) (semántico)
          5. si hay errores semánticos → { valid: false, errors }
          6. → { valid: true, pkg }
      → busca scenarioId dentro de pkg.scenarios
          no existe → { outcome: "scenario_not_found" }
      → arma ResolvedScenarioConfig (lookups garantizados por el paso 4)
          → { outcome: "resolved", config }
```

`organizationId` **siempre** viene de `req.appContext.organizationId` (Fase 2-3, resuelto server-side desde Membership) — nunca del body. `scenarioId` es lo único que el request puede elegir, y siempre se verifica contra el paquete real de esa organización — exactamente el mismo patrón de "selección, nunca autoridad" que ya se usaba para `?organization_id` en Fases 2-3.

---

## SCHEMA_VALIDATION

Zod, no casts de TypeScript, en cada uno de los 6 esquemas (`Manifest`, `ClientConfig`, `InterviewerProfile`, `Scenario`, `EvaluationFramework`, `ContentSource`) — `backend/src/engine-config/schema.ts`. Una configuración inválida falla **antes** de poder iniciar una sesión: `loader.ts` corre toda la validación al momento de resolver, no perezosamente en medio de construir un prompt.

Casos verificados con test (`schema.test.ts`, 14 tests): pesos que no suman `maxScore`, criterios duplicados, peso negativo/cero, `evaluationInstructions` faltante, slot de voz inválido, id con caracteres no permitidos, timing negativo, tipo de content source desconocido, manifest sin escenarios.

---

## SEMANTIC_VALIDATION

Más allá del schema por archivo, `validatePackageReferences()` (`loader.ts`) valida relaciones **dentro del paquete completo**:

- todo `scenario.interviewerProfileId` existe entre los perfiles cargados;
- todo `scenario.evaluationFrameworkId` existe entre los frameworks cargados;
- todo `scenario.contentSourceIds[]` existe entre los content sources cargados;
- `client.defaultScenarioId` (si está presente) existe entre los escenarios;
- sin ids duplicados dentro de cada categoría (perfiles, escenarios, frameworks, content sources);
- **MANIFEST_COMPLETENESS** (extra, no pedida explícitamente pero necesaria para que el manifest sea confiable): todo lo que el manifest declara existe en disco, y todo lo que existe en disco está declarado en el manifest — evita que un paquete "mienta" sobre lo que contiene.

11 tests (`loader.test.ts`) contra fixtures hechas a mano, más 3 tests adicionales corriendo el loader REAL contra los paquetes REALES ya shippeados (`sas-colombia`, `acme-demo`) — prueba que el contenido migrado de verdad pasa ambas validaciones, no solo fixtures de prueba.

---

## ELEVENLABS_INTEGRATION

`getSignedUrl(resolved: ResolvedScenarioConfig, requestedVoice?)` — ya no recibe `TargetMode`. La selección de voz lee `resolved.interviewerProfile.voice.slot` (con `requestedVoice` como override opcional del caller, igual que antes con el modo "genérico"); el `agent_id` de ElevenLabs sigue siendo un solo agente para todos los escenarios (override de prompt/voz por request, sin cambios de esa parte). `buildOverrides` arma el prompt vía `engine/promptBuilder.ts`, nunca importa nada de un paquete de config específico.

Probado en `elevenlabs.test.ts` (4 tests): la voz se resuelve desde `voice.slot`, no desde un target; un override explícito gana sobre el slot configurado; dos organizaciones distintas producen overrides de prompt distintos a través de la MISMA función, sin ninguna rama por cliente.

---

## EVALUATOR_INTEGRATION

`evaluatePitch({ sessionId, resolved: ResolvedScenarioConfig, transcript, durationSeconds, metrics })` — ya no recibe `target: TargetMode`. `buildEvaluatorSystemPrompt`/`buildEvaluatorUserMessage` (`engine/evaluatorPromptBuilder.ts`) arman el prompt desde `resolved.evaluationFramework`, nunca desde una rúbrica fija importada. El prompt universal del evaluador (`ENGINE_EVALUATOR_SYSTEM_PROMPT`) se reescribió para ser genérico — la versión anterior literalmente decía *"evaluador experto en... posicionamiento estratégico de SAS"* en el texto que se mandaba a OpenRouter en CADA evaluación, de cualquier cliente; ahora dice *"evaluador experto en comunicación ejecutiva y vocería corporativa"* y punto — lo específico de SAS vive en `evaluationInstructions` del framework, no en el motor.

Probado en `evaluatorPromptBuilder.test.ts` (4 tests): el prompt final nunca contiene la rúbrica de un framework que no sea el resuelto; dos frameworks distintos (criterios/ids/pesos distintos) producen prompts de usuario que contienen los criterios correctos y **no** contienen `message_clarity`/`playbook_alignment` (ids de la vieja rúbrica SAS hardcodeada) cuando el framework resuelto es de otra organización.

---

## TARGET_MODE_MIGRATION

`TargetMode` dejó de ser `"generic" | "davivienda" | "grupo_aval"` y pasó a ser `type TargetMode = string` — un alias que existe **únicamente** para el campo de wire `target_mode` en `StartSessionRequest`/`SessionRecord`/`EvaluationResult`. La nueva abstracción de dominio es `scenarioId` (string plano, resuelto dentro de la organización) — `engine-config/*` y `engine/*` no importan ni usan `TargetMode` en ningún punto.

`routes.ts` lee `body.target_mode` y lo trata como `scenarioId` desde la primera línea; nunca hay un `VALID_TARGETS.includes(...)` — la validez la decide `resolveScenarioConfig` contra el paquete real de la organización, no una lista fija en código.

Los 3 escenarios reales conservan sus ids históricos (`generic`, `davivienda`, `grupo_aval`) byte a byte — incluido el guion bajo de `grupo_aval`, que `IdSchema` ahora acepta explícitamente (kebab-case **o** snake_case) precisamente para no romper esta compatibilidad.

---

## FRONTEND_COMPATIBILITY

**Cero archivos de `frontend/` se tocaron en esta fase.** `npm run build --workspace=frontend` pasa sin cambios porque el contrato de wire no cambió: `/session/start` sigue aceptando `target_mode` en el body y devolviéndolo en la respuesta; `/session/end` igual. El frontend sigue enviando literalmente `"generic"`, `"davivienda"` o `"grupo_aval"` — que ahora el backend trata como `scenarioId` en vez de como un enum cerrado, pero el string en el wire es idéntico.

**Capa de compatibilidad, documentada explícitamente:**
- `backend/src/types.ts`: `TargetMode = string` (antes union cerrado) — comentario explícito marcándolo deprecado.
- `backend/src/routes.ts`: dos comentarios "deprecated wire-compat mirror" en los puntos donde `scenario_id` se copia a `target_mode` para la respuesta/persistencia.
- `frontend/src/config.ts` (`TARGETS`) y `frontend/src/types.ts` (`TargetMode`) **siguen exactamente igual que antes** — el frontend sigue teniendo su propia lista hardcodeada de 3 escenarios con labels/colores. Esto es contenido de UI (qué mostrar en la pantalla de selección), no lógica de negocio del motor — pero es honesto reconocer que technically sigue siendo "hardcode client-specific" del lado del cliente. No se tocó porque el prompt de esta fase pidió explícitamente "NO dashboard, NO rediseño, NO nuevo flujo UX" — resolverlo (un endpoint que liste los escenarios disponibles de la organización, y que el frontend los consuma dinámicamente) es trabajo natural de una fase de dashboard/gestión de config (Fase 11/12), no de esta.

---

## STORAGE_STRATEGY

Fixtures JSON en `backend/config-packages/<organizationId>/<version>/` para esta fase, tal como autorizó el prompt. El acoplamiento a "archivo" vive **únicamente** en `FileConfigPackageLoader` (`loader.ts`), detrás de la interfaz `ConfigPackageLoader`:

```ts
interface ConfigPackageLoader {
  loadPackage(organizationId: string): Promise<ConfigPackageResult>;
}
```

`resolveScenarioConfig` recibe un loader inyectable (default: `FileConfigPackageLoader`) — exactamente el mismo patrón inyectable que `requireAuth`/`requireMembership`/`claimSessionForEvaluation` de fases anteriores. Migrar a Firestore más adelante (Fase 6/12) significa escribir **una clase nueva** que implemente la misma interfaz (leer `organizations`, `interviewer_profiles`, etc. de Firestore en vez de `fs.readdir`) — cero cambios en `resolver.ts`, `engine/*`, ni `routes.ts`.

**Detalle de despliegue encontrado y corregido en esta misma fase:** `backend/Dockerfile` copiaba `src`/`dist` pero no `config-packages/` a la imagen de producción — sin este fix, el motor habría funcionado en local (`tsx`/`npm run dev`) pero fallado en el VPS con "no config package" para cualquier organización, un bug silencioso de despliegue que solo se habría visto después de desplegar. Corregido agregando `COPY config-packages ./config-packages` a la etapa `runtime`. Verificado manualmente: el loader compilado en `dist/` resuelve correctamente `../../config-packages/` relativo a su propia ubicación, sin necesitar copiar nada dentro de `dist/` — confirmado ejecutando el loader compilado directamente contra `backend/dist/`.

---

## CONTENT_PUSH_CONTRACT

Contrato técnico para que un paquete de cliente nuevo sea aceptable, verificado punto por punto contra lo que esta fase realmente construyó:

| # | Condición | Cómo se cumple |
|---|---|---|
| 1 | No modifica archivos del engine | Un paquete nuevo es solo una carpeta nueva bajo `config-packages/` — `engine/*` y `engine-config/*` no cambian |
| 2 | No agrega branches por cliente | No hay ningún `if`/`switch` por `organizationId` o `scenarioId` en `engine/*`, `engine-config/*`, `routes.ts`, `elevenlabs.ts` ni `evaluator.ts` (verificado por grep, ver `FILES_CHANGED`) |
| 3 | Cumple el schema | `FileConfigPackageLoader` valida cada archivo con Zod antes de aceptar el paquete |
| 4 | Pasa validaciones de referencias | `validatePackageReferences` — sin esto, `loadPackage` devuelve `valid: false` |
| 5 | Contiene ids estables | `IdSchema` fuerza minúsculas + kebab/snake; nada impide reutilizar ids entre paquetes (de hecho `acme-demo` reutiliza `"generic"` a propósito) |
| 6 | Se resuelve por organizationId + scenarioId | Es literalmente la firma de `resolveScenarioConfig` |
| 7 | No requiere nuevo TargetMode | `TargetMode` ya es `string` — no hay enum que extender |
| 8 | No requiere modificar evaluator | `evaluator.ts` consume `ResolvedScenarioConfig` genéricamente |
| 9 | No requiere modificar integración ElevenLabs | `elevenlabs.ts` consume `ResolvedScenarioConfig` genéricamente |
| 10 | No requiere modificar componentes frontend client-specific | El wire contract no cambió; ver `FRONTEND_COMPATIBILITY` para la única pieza de UI que sigue siendo estática (fuera de alcance de esta fase) |

`acme-demo` es la prueba viva de este contrato: se agregó sin tocar una sola línea de `engine/*`, `engine-config/*` ni `routes.ts`.

---

## FILES_CHANGED

**Eliminados**
- `backend/src/data/prompts.ts`, `rubrics.ts`, `profiles.ts`, `playbook.ts`, `evaluatorPrompt.ts` — contenido migrado a `config-packages/sas-colombia/`.

**Nuevo — dominio de configuración**
- `backend/src/engine-config/schema.ts` — los 6 schemas Zod + `ResolvedScenarioConfig`.
- `backend/src/engine-config/loader.ts` — `FileConfigPackageLoader`, `validatePackageReferences`.
- `backend/src/engine-config/resolver.ts` — `resolveScenarioConfig`, `listScenarioIds`.
- `backend/src/engine-config/{schema,loader,resolver}.test.ts` — 34 tests.

**Nuevo — motor genérico**
- `backend/src/engine/promptBuilder.ts` — prompt del entrevistador.
- `backend/src/engine/evaluatorPromptBuilder.ts` — prompt del evaluador.
- `backend/src/engine/{promptBuilder,evaluatorPromptBuilder}.test.ts` — 9 tests.

**Nuevo — paquetes de configuración**
- `backend/config-packages/sas-colombia/v1/**` — manifest, client, 3 interviewer-profiles, 3 scenarios, 3 evaluation-frameworks, 4 content sources (contenido real migrado).
- `backend/config-packages/acme-demo/v1/**` — paquete de demostración (1 de cada, contenido ficticio).

**Modificado**
- `backend/src/types.ts` — `TargetMode` widened a `string`; `SessionRecord.scenario_id` nuevo (canónico), `target_mode` deprecado.
- `backend/src/routes.ts` — `/session/start` resuelve `scenarioId`; `/session/end` re-resuelve desde lo persistido.
- `backend/src/services/elevenlabs.ts` — `getSignedUrl`/`buildOverrides` toman `ResolvedScenarioConfig`.
- `backend/src/services/evaluator.ts` — `evaluatePitch` toma `ResolvedScenarioConfig`.
- `backend/src/services/evaluator.test.ts` — actualizado al nuevo contrato.
- `backend/src/routes.test.ts` — mocks actualizados + nuevo `describe("Phase 5: ENGINE vs CONFIG")` (5 tests).
- `backend/Dockerfile` — copia `config-packages/` a la imagen de runtime.
- `backend/package.json` — dependencia `zod`.

**Nuevo — tests adicionales**
- `backend/src/services/elevenlabs.test.ts` — 4 tests (no existía antes de esta fase).

---

## TESTS_ADDED

**`engine-config/schema.test.ts` (14):** framework válido; pesos que no suman `maxScore` (WEIGHTS_SUM_RULE); criterios duplicados; peso ≤0; sin `evaluationInstructions`; perfil válido; slot de voz inválido; default de `requiredCount`; id con formato inválido; escenario válido; id `grupo_aval` (snake_case) aceptado; timing negativo; `contentSourceIds` por defecto `[]`; `ClientConfig` mínimo; tipo de content source desconocido; manifest sin escenarios.

**`engine-config/loader.test.ts` (14):** paquete internamente consistente sin errores; referencia a interviewerProfileId/evaluationFrameworkId/contentSourceId inexistente (3); ids duplicados (2); `defaultScenarioId` inválido; manifest declara algo que no existe en disco; algo en disco no declarado en manifest; **contra los paquetes reales:** `sas-colombia` carga y valida con sus 3 escenarios reales, `acme-demo` carga y valida, una organización sin paquete devuelve `valid:false` con errores.

**`engine-config/resolver.test.ts` (6):** resuelve un `(organizationId, scenarioId)` válido; `scenario_not_found`; `no_config_for_organization`; **dos organizaciones con el mismo `scenarioId` no colisionan** (con aserción explícita de que cada una devuelve SU PROPIA descripción); un caller no puede resolver el `scenarioId` de otra organización por más que lo pida; el mismo `resolveScenarioConfig` resuelve dos configs estructuralmente distintas sin ninguna rama.

**`engine/promptBuilder.test.ts` (5):** ensambla persona/tono/behavior/contexto/cierre/preguntas/contenido de una organización; dos organizaciones producen prompts distintos sin contaminación cruzada; el conteo de repreguntas viene de config, no hardcodeado; soporta 0 repreguntas requeridas sin caso especial por cliente; sin content sources no deja `"undefined"` en el prompt.

**`engine/evaluatorPromptBuilder.test.ts` (4):** el framework's `evaluationInstructions` se agrega al prompt universal; dos frameworks distintos nunca se contaminan entre sí; el mensaje de usuario serializa los criterios/pesos del framework RESUELTO, nunca la vieja rúbrica SAS hardcodeada (verificado buscando explícitamente `message_clarity`/`playbook_alignment`, que NO deben aparecer); incluye descripción del escenario + transcript.

**`services/elevenlabs.test.ts` (4, nuevo):** la voz se resuelve desde `voice.slot` de la config, no de un target; un override de voz explícito gana sobre el slot; dos organizaciones producen overrides de prompt distintos a través de la misma función.

**`services/evaluator.test.ts` (actualizado):** mismos 11 tests de Fase 4 (timeout/retry/categorías), adaptados al nuevo parámetro `resolved` en vez de `target`.

**`routes.test.ts` → `describe("Phase 5: ENGINE vs CONFIG")` (5, nuevo):** `/session/start` resuelve config genéricamente y persiste `scenario_id` (sin rama hardcodeada); `scenario_id` desconocido → 400; organización sin config válida → 503 sin filtrar detalles internos; dos organizaciones resuelven el mismo `scenario_id` a su propia config distinta, a través del mismo código; `/session/end` re-resuelve desde el `scenario_id` PERSISTIDO, ignorando cualquier `target_mode` que el body intente inyectar.

Todos los tests de Fases 1–4 se mantienen verdes sin cambiar sus expectativas (solo se actualizaron los mocks de `routes.test.ts` para reflejar el nuevo parámetro de `getSignedUrl` y se agregó el mock del resolver).

---

## TEST_RESULTS

```
$ npm test
> npm run test --workspace=backend && npm run test --workspace=frontend

backend:  Test Files  15 passed (15) | Tests  173 passed (173)
frontend: Test Files   1 passed (1)  | Tests    4 passed (4)
```

(173 backend = 121 de Fases 1–4 + 52 nuevas de Fase 5: 14+14+6 en `engine-config/` + 5+4 en `engine/` + 4 en `services/elevenlabs.test.ts` + 5 en `routes.test.ts`.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores (cero archivos de frontend tocados)
```

Además, el loader real se ejecutó manualmente contra ambos paquetes reales (`sas-colombia`, `acme-demo`) antes de escribir los tests formales, y contra el `dist/` compilado (no solo `src/` vía `tsx`) para confirmar que la resolución de rutas funciona igual en producción — ver `STORAGE_STRATEGY`.

---

## KNOWN_LIMITATIONS

- **El frontend sigue teniendo su propia lista hardcodeada de 3 escenarios** (`frontend/src/config.ts`) — ver `FRONTEND_COMPATIBILITY`. No es lógica de motor, pero es contenido específico de cliente en el cliente. Resolverlo (un endpoint que liste escenarios por organización) es trabajo natural de Fase 11/12, no de esta.
- **Solo existe una versión (`v1`) de cada paquete.** `pickVersionDir` ya soporta múltiples versiones (toma la más reciente alfabéticamente), pero no hay versionado real ni provenance por sesión todavía — eso es explícitamente Fase 6, no se adelantó.
- **No hay caché de paquetes cargados.** Cada `resolveScenarioConfig` vuelve a leer y validar los archivos JSON desde disco. Proporcional para el volumen actual (2 paquetes pequeños); si el volumen crece o se migra a Firestore, cachear el resultado de `loadPackage` por `(organizationId, version)` sería la optimización natural.
- **`acme-demo` es un paquete puramente demostrativo**, sin ninguna Organization/Membership real en Firestore apuntando a él — no hay ningún usuario que pueda autenticarse y usarlo hoy. Existe únicamente para probar en tests que el modelo soporta una segunda organización sin colisión.
- **El Dockerfile ahora copia `config-packages/` completo a cada build de imagen**, incluyendo `acme-demo`. Antes de desplegar de verdad, vale la pena decidir si el paquete de demostración debe viajar a producción o quedarse solo en el repo/dev.
- **No se implementó ningún mecanismo de "activo"/"borrador"** más allá del campo `manifest.status` (`"active" | "deprecated"`), que hoy no se usa para nada (el loader no lo consulta) — dejado como un campo preparado, no una funcionalidad.

---

## MIGRATION_NOTES

- **Nada de esto está desplegado.** Producción sigue en el código de Fase 0.
- **El fix de `Dockerfile` (copiar `config-packages/`) es un prerequisito real para desplegar esta fase** — sin él, el backend en el VPS respondería 503 ("Esta organización no tiene configuración disponible") en cualquier intento de `/session/start`, aunque todo funcione en local. Detectado y corregido dentro de esta misma fase, no quedó como deuda.
- **No se requiere ninguna migración de datos en Firestore.** El contenido de configuración vive en archivos del repo, no en Firestore, en esta fase — desplegar es simplemente desplegar el código + los archivos nuevos (ya versionados en git).
- **Los IDs de escenario no cambiaron** (`generic`, `davivienda`, `grupo_aval`) — las sesiones ya persistidas en Firestore (de fases anteriores, con `target_mode` pero sin `scenario_id`) siguen siendo legacy exactamente como ya lo eran (ver `LEGACY_SESSION_POLICY` de Fase 3/4) — esta fase no cambia esa política ni la extiende.
- **Variables de entorno:** ninguna nueva. Las voces de ElevenLabs (`ELEVEN_VOICE_MALE`, etc.) se siguen leyendo exactamente igual, solo que ahora `InterviewerProfile.voice.slot` decide CUÁL de ellas usar en vez de un `if` por target.

---

## OPEN_ITEMS

- [ ] Revisar y aprobar este reporte.
- [ ] Decidir si `acme-demo` viaja a la imagen de producción o se excluye antes de desplegar.
- [ ] Fase 6: versioning/provenance real — qué config exacta usó cada sesión, para que resultados históricos sigan siendo auditables aunque la config cambie después.
- [ ] Fase 11/12: endpoint dinámico de escenarios por organización, para que el frontend deje de tener su propia lista hardcodeada (ver `KNOWN_LIMITATIONS`).
- [ ] Cuando el volumen de paquetes/organizaciones crezca: cachear `loadPackage` por `(organizationId, version)`.
- [ ] Onboarding real de Novo (fuera de esta fase, explícitamente): normalizar su contenido contra este mismo schema, como cualquier paquete nuevo — el `CONTENT_PUSH_CONTRACT` ya define las condiciones.

---

**Commit de código de esta fase:** `25700d85f4c4a615672ad5407c87831ef5519ae5`
**Este reporte:** commiteado por separado, después del código.

---

## PHASE_05_FIXES_ADDENDUM

**Veredicto de revisión:** `PASS_WITH_FIXES`. Arquitectura ENGINE vs CONFIG aprobada; se pidió cerrar residuos client-specific dentro de contratos supuestamente genéricos. **No se rehizo `loader.ts`/`resolver.ts` ni el núcleo de `schema.ts`. No se avanzó a Fase 6.**
**Commit del fix (código):** `194f638f612d03daa7b2d61961d08b1719750df3`

### 1. `SpeechMetrics` sin conocimiento de SAS

`services/metrics.ts` eliminó `SAS_RE` y el campo `mentioned_sas` por completo — ya no existe ni la constante ni la key en el objeto devuelto. `SpeechMetrics` (`types.ts`) ya no declara `mentioned_sas`. Las métricas deterministas genéricas que el prompt explícitamente permitió mantener siguen intactas: `word_count`, `words_per_minute`, fillers, repetitions, `numbers_detected`/`used_numbers`, `has_cta`, `long_pauses_count`. Probado en `services/metrics.test.ts` (nuevo): el objeto nunca tiene la key `mentioned_sas`, y el set de keys devuelto es idéntico con o sin la palabra "SAS" en el transcript.

### 2-3. `detected_requirements` genérico + requirements config-driven

**Antes:** `EvaluationResult.detected_requirements` era un objeto fijo con keys client-specific (`mentioned_sas`, `aligned_to_playbook`) mezcladas con métricas deterministas (`used_numbers`, `numbers_detected`, `has_cta`). El `OUTPUT_SCHEMA` universal de `evaluatorPromptBuilder.ts` declaraba esas mismas keys fijas, y `frameworkInputs.metrics` enviaba explícitamente `mentioned_sas: metrics.mentioned_sas`.

**Ahora:**
- `EvaluationResult.detected_requirements` (`types.ts`) es `Array<{ id: string; detected: boolean; evidence: string }>` — un elemento por cada requirement que el `EvaluationFramework` resuelto declare. Ningún campo con nombre de cliente en el contrato universal.
- `used_numbers`/`numbers_detected`/`has_cta` (deterministas, calculados por `metrics.ts`, nunca juzgados por el LLM) se movieron a `EvaluationResult.speech_metrics`, junto al resto de métricas deterministas — separación limpia entre "lo que el engine mide" y "lo que el framework pide verificar".
- `EvaluationFrameworkSchema` (`engine-config/schema.ts`) gana un campo **aditivo y opcional**: `requirements: Array<{id, description}>` (default `[]`, con su propio chequeo de ids duplicados en el `superRefine` existente). No es un rediseño del schema — frameworks que no lo necesitan (`davivienda-v1`, `grupo-aval-v1`) no se tocaron.
- `sas-colombia/v1/evaluation-frameworks/generic-v1.json` ahora declara `requirements: [{id: "mentioned_sas", ...}, {id: "aligned_to_playbook", ...}]` — la migración concreta de esos dos campos de TypeScript a config.
- `acme-demo/v1/evaluation-frameworks/press-generic-v1.json` declara su propio requirement, distinto (`verifiable_data`) — prueba viva de que agregar un requirement de un cliente nuevo es editar JSON, nunca tocar `EvaluationResult` ni el engine.
- El `OUTPUT_SCHEMA` universal (`evaluatorPromptBuilder.ts`) ahora describe el shape genérico `[{id, detected, evidence}]` y es **byte-idéntico** entre frameworks (verificado por test); la instrucción de cómo llenarlo (un elemento por requirement declarado, mismo id) se agregó como regla general del prompt, no como dato específico de un cliente.

Probado en `engine/evaluatorPromptBuilder.test.ts` (5 tests nuevos): dos frameworks con requirements distintos producen contenido de prompt distinto sin ninguna rama de código; el bloque `OUTPUT_SCHEMA` es idéntico entre frameworks; el paquete **real** de `acme-demo` (cargado vía `FileConfigPackageLoader` + `resolveScenarioConfig`, sin mocks) no produce `"mentioned_sas"` ni el texto `"SAS"` en ningún prompt construido, y sí produce `"verifiable_data"` (su propio requirement). También en `engine-config/schema.test.ts` (3 tests nuevos): `requirements` por defecto vacío, acepta una lista arbitraria, rechaza ids duplicados.

**Nota sobre contenido, no código:** `acme-demo/v1/content/acme-facts.json` mencionaba literalmente la palabra "SAS" en su propio texto descriptivo ("...contenido de un cliente distinto de SAS..."). No es un defecto del engine — es contenido de config, inyectado verbatim — pero un paquete de demostración pensado para probar independencia de cliente no debería necesitar nombrar a otro cliente en su propio texto. Se reescribió para no mencionar "SAS", dejando la prueba de independencia limpia end-to-end.

### 4. Sin nombres de persona hardcodeados

`evaluatorPromptBuilder.ts`'s `transcriptToText()` y `repositories/sessions.ts`'s `persistCompletedResult()` serializaban el transcript con `"SANDRA"` hardcodeado para `role: "user"`. Ambos ahora usan las mismas etiquetas neutrales: **`VOCERO`** (spokesperson) / **`ENTREVISTADOR`** (antes `sessions.ts` usaba además `"AGENTE"`, distinto de `evaluatorPromptBuilder.ts`; se unificó a `ENTREVISTADOR` en los dos paths para que la misma sesión no tenga dos etiquetas distintas para el mismo rol según qué código la serialice). También se limpiaron dos comentarios residuales que mencionaban "Sandra" (`engine-config/schema.ts`, `services/metrics.ts`) — texto, no comportamiento.

Probado en `engine/evaluatorPromptBuilder.test.ts` y `repositories/sessions.test.ts`: el string `"SANDRA"` nunca aparece en el prompt del evaluador ni en el transcript persistido; ambos paths usan `VOCERO`/`ENTREVISTADOR` sin importar el contenido del transcript.

### 5. Tests que demuestran los 5 puntos pedidos

| Punto pedido | Dónde |
|---|---|
| `SpeechMetrics` sin conocimiento de SAS | `services/metrics.test.ts` (nuevo, 4 tests) |
| Config Acme no produce `"mentioned_sas"` ni texto `"SAS"` | `engine/evaluatorPromptBuilder.test.ts` — test contra el paquete REAL de `acme-demo` |
| Dos frameworks definen requirements distintos sin tocar código | `engine/evaluatorPromptBuilder.test.ts` — test de contenido de prompt distinto |
| El output contract universal sigue siendo el mismo | `engine/evaluatorPromptBuilder.test.ts` — test de `OUTPUT_SCHEMA` byte-idéntico entre frameworks |
| Transcript serialization no depende de un nombre humano fijo | `engine/evaluatorPromptBuilder.test.ts` + `repositories/sessions.test.ts` — ambos contra `"SANDRA"` |

### 6. Alcance real del contrato "no-code"

Corrección explícita pedida por la revisión:

> **Backend content-push contract: achieved.** Un paquete de cliente nuevo (config JSON válido bajo `config-packages/<org>/`) se resuelve, valida y sirve sin tocar `engine/*`, `engine-config/*` ni `routes.ts` — ver `CONTENT_PUSH_CONTRACT` arriba, ahora también cierto para `requirements`.
>
> **End-to-end no-code onboarding: pending dynamic frontend scenario discovery (later phase).** `frontend/src/config.ts` sigue manteniendo los 3 escenarios estáticos de SAS (`TARGETS`) — un cliente nuevo hoy no aparece en la UI de selección sin un cambio de código en el frontend. Esto ya estaba documentado en `KNOWN_LIMITATIONS`/`FRONTEND_COMPATIBILITY` de la versión original de este reporte, pero no estaba dicho con esta precisión; queda explícito aquí para que "backend generico" no se lea como "onboarding completo". No se tocó el frontend en esta ronda de fixes (instrucción explícita de la revisión).

**KNOWN_LIMITATION nueva, descubierta en esta ronda (no corregida — instrucción explícita de no tocar frontend):** `frontend/src/components/Analysis.tsx` lee `evaluation.detected_requirements.{used_numbers, mentioned_sas, has_cta, aligned_to_playbook}` como si `detected_requirements` fuera todavía el objeto fijo de antes. Con el nuevo contrato (`detected_requirements` como array), esas 4 lecturas devuelven `undefined` en runtime — los 4 checkmarks de la sección "Requisitos mínimos" del panel de análisis van a mostrar siempre "✗ no detectado", incluso cuando el backend sí detectó el requirement correspondiente en `detected_requirements[]`. No es un error de compilación (`frontend/src/types.ts` es un contrato estático independiente, no validado contra la respuesta real del backend) y `npm run build` del frontend pasa sin errores. `frontend/src/components/Report.tsx` NO se ve afectado — sus lecturas (`metrics.numbers_detected`, `metrics.has_cta`) vienen de `SpeechMetrics`, que no cambió de forma. Corregir `Analysis.tsx` para leer el nuevo array (y, más de fondo, para renderizar dinámicamente los requirements que el framework resuelto declare en vez de 4 líneas fijas) es trabajo natural de la fase de onboarding no-code de frontend (11/12), consistente con la nota de alcance de arriba — no se adelantó aquí.

### 7. Versionado: confirmado temporal

Se agregó un comentario explícito (`TEMPORARY_VERSION_SELECTION`) en `engine-config/loader.ts` junto a `pickVersionDir()`, marcando que `entries.sort().reverse()` es un placeholder sin semver real, sin pinning de versión por sesión y sin manejo de `manifest.status` más allá de la elección lexicográfica — y que **no debe sobrevivir** al diseño real de versionado de Fase 6. Cero cambio de comportamiento; el comentario ya existente (`"Phase 5 keeps this deliberately trivial... real version selection is Phase 6"`) se mantuvo y se amplió, no se reemplazó.

### Resultados

```
$ npm test
backend:  Test Files  16 passed (16) | Tests  185 passed (185)
frontend: Test Files   1 passed (1)  | Tests    4 passed (4)
```

(185 backend = 173 de la versión original de Fase 5 + 12 nuevas: 4 en `services/metrics.test.ts` + 5 en `engine/evaluatorPromptBuilder.test.ts` + 3 en `engine-config/schema.test.ts` + 1 en `repositories/sessions.test.ts` — la resta a 173+12=185 cuadra porque además se agregó 1 archivo de test nuevo, `metrics.test.ts`, contado en "Test Files".)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores (cero archivos de frontend modificados)
```

**No se desplegó. No se avanzó a Fase 6.**
