# PHASE_07_RELIABILITY_PROVIDER_HARDENING_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 7 de 15 — RELIABILITY / PERSISTENCE / PROVIDER HARDENING
**Commit base aprobado (Fases 1–6, cerradas):** `f65a396f6daa6c33090c2758f17ef2050790b230`
**Código de esta fase:** `eb9f2ab696a37d28507fc028fbbc03c30f4e3fc9`
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado. NO se escribió en Firestore real, salvo un incidente reportado abajo.**

---

## INCIDENTE A DECLARAR (transparencia obligatoria)

Durante la verificación manual de `mark-stale-evaluating-sessions.ts` se ejecutó `npx tsx backend/scripts/mark-stale-evaluating-sessions.ts --dry-run` directamente en esta máquina. El script se conectó a **Firestore real** (proyecto `smartpr-pitch-agent`, credenciales en `backend/secrets/serviceAccount.json`) y ejecutó **una query de lectura** (`status == "evaluating"`). Resultado: 0 documentos encontrados, **ninguna escritura** (`--dry-run` no persiste). No se volvió a ejecutar ningún script contra Firestore real después de detectar esto — el resto de la verificación de scripts fue estática (lectura de código) + tests unitarios con `firebase.js` mockeado.

---

## WHAT_CHANGED

- **Runtime + semantic validation del evaluator** (`backend/src/services/evaluatorSchema.ts`, nuevo): reemplaza `JSON.parse(...) as EvaluationResult` por validación Zod estructural (`LlmEvaluationResponseSchema`) + validación semántica contra el `EvaluationFramework` pinneado (`validateEvaluationContract`). Wireado en `evaluator.ts`.
- **ElevenLabs response validation + taxonomía de error** (`backend/src/services/elevenlabs.ts`): un `200` sin `signed_url` válido ahora falla (`ELEVENLABS_INVALID_RESPONSE`, vía Zod). Nueva clase `ElevenLabsError` con 6 categorías, paralela a `EvaluationError`.
- **Stale evaluating recovery**: nueva función de lectura `listEvaluatingSessionsOlderThan` (`repositories/sessions.ts`) + script CLI `backend/scripts/mark-stale-evaluating-sessions.ts` (`--hours=N --dry-run`), calco de `mark-abandoned-sessions.ts`, reutilizando `SessionRecord.updated_at` y `markEvaluationFailed`.
- **Firestore best-effort logging normalizado**: los tres `.catch(() => {})` silenciosos de `markEvaluationFailed` en `routes.ts` (rutas `LEGACY_CONFIG_VERSION_UNKNOWN`, `CONFIG_VERSION_RESOLUTION_FAILED`, `CONFIG_PROVENANCE_HASH_MISMATCH`) ahora pasan por `markEvaluationFailedLogged`, que loguea el error igual que el sitio que ya lo hacía bien.
- **Structured logging** (`backend/src/observability/log.ts`, nuevo): `logEvent`/`elapsedMs`, con `LogFields` como whitelist de tipos (ver REDACTION_POLICY). Wireado en `evaluator.ts` (latencia por intento OpenRouter + latencia total), `elevenlabs.ts` (latencia signed-url) y `routes.ts` (latencia de los 3 writes críticos de Firestore: `createSession`, `claimSessionForEvaluation`, `persistCompletedResult`).

No se tocó: lifecycle/state machine (Fase 4), versioning/provenance (Fase 6), tenant isolation/RBAC (Fase 3), arquitectura `browser ↔ ElevenLabs` direct WebSocket, ni el frontend (cero archivos modificados).

---

## DEPENDENCY_INVENTORY

| Dependencia | Operación | Critical path | Timeout | Retry | Comportamiento ante fallo |
|---|---|---|---|---|---|
| Firebase Auth | `verifyIdToken` | Todas las rutas protegidas | El propio SDK de Firebase Admin | No (no aplica) | 401, sin detalle |
| Firestore | `createSession` | `/session/start` (único write en critical path, por diseño) | El propio SDK | No | 503, sin leak de detalle |
| Firestore | `claimSessionForEvaluation` (transacción) | `/session/end` | El propio SDK | No (Firestore reintenta el loser de una transacción internamente) | 503 |
| Firestore | `persistCompletedResult` | `/session/end` | El propio SDK | No | Ambiguous-ack recovery (Fase 4) + `markPersistenceFailed` |
| Firestore | `markEvaluationFailed` / `markPersistenceFailed` en rutas fail-closed | `/session/end` (rutas de error) | El propio SDK | No | Best-effort, ahora **siempre logueado** (ver FIRESTORE_FAILURE_POLICY) |
| OpenRouter | evaluación (chat completions) | `/session/end` | 30s por intento (`EVALUATION_TIMEOUT_MS`) | 1 retry en 429/5xx/timeout/red, backoff 500ms | `EvaluationError` con categoría segura, sin retry en 4xx/schema/contract |
| ElevenLabs | `get-signed-url` | `/session/start` | 10s (`SIGNED_URL_TIMEOUT_MS`) | Sin retry (decisión deliberada, ver justificación en el código — un reintento de todo `/session/start` es igual de barato) | `ElevenLabsError` con categoría segura |

---

## OPENROUTER_POLICY

Sin cambios de comportamiento — se **confirmó y formalizó** lo ya implementado desde Fase 4 ([evaluator.ts:22-24](backend/src/services/evaluator.ts)):

## OPENROUTER_TIMEOUTS
- 30 000 ms por intento (`EVALUATION_TIMEOUT_MS`), vía `AbortController`.

## OPENROUTER_RETRIES
- Máximo 1 retry adicional (`MAX_TRANSIENT_RETRIES = 1`, total 2 intentos), backoff fijo 500ms.
- Retryable: `timeout`, error de red, `429`, `5xx`.
- No retryable: `4xx` (distinto de 429), `INVALID_JSON`, `INVALID_RESPONSE_SCHEMA`, `INVALID_EVALUATION_CONTRACT` — ninguno de estos se resuelve reintentando la misma llamada.

---

## EVALUATOR_RUNTIME_VALIDATION

Nuevo módulo `backend/src/services/evaluatorSchema.ts`. `LlmEvaluationResponseSchema` (Zod) valida la forma estructural completa de la respuesta cruda del LLM (todos los campos de `EvaluationResult` salvo `session_id`/`target_mode`, que `attemptEvaluation` sobreescribe incondicionalmente después del parseo — validarlos sería una fuente de rechazos espurios). `detected_requirements` en el schema NO incluye `description` — el prompt le pide al modelo que nunca la incluya; `enrichDetectedRequirements` la adjunta después, siempre desde el framework, nunca del modelo.

Un fallo de forma (campo faltante, tipo incorrecto, enum inválido, `criteria_scores` vacío) se clasifica `OPENROUTER_INVALID_RESPONSE_SCHEMA`, no transitorio.

## EVALUATOR_SEMANTIC_VALIDATION

`validateEvaluationContract(result, framework)` — función pura, retorna lista de violaciones (vacía = válido). Reglas implementadas, contra el `EvaluationFramework` PINNEADO de la sesión:

- Cada `criterion_id` en `criteria_scores` debe existir en `framework.criteria`, aparecer **exactamente una vez**; falta uno declarado → violación; id desconocido → violación; duplicado → violación.
- `criteria_scores[].max_score` debe ser igual (con tolerancia de centésimas) al `weight` del criterio en el framework — no es un campo libre del modelo, es una propiedad derivada que debe cuadrar.
- Igual patrón (cobertura exacta, sin desconocidos, sin duplicados) para `detected_requirements` contra `framework.requirements`. Framework con `requirements: []` exige `detected_requirements: []`.
- `0 <= score <= max_score` por criterio, `0 <= overall_score <= framework.maxScore`.

Cualquier violación se clasifica `OPENROUTER_INVALID_EVALUATION_CONTRACT`, no transitorio (un reintento no cambia cómo el modelo puntúa).

**Cambio de comportamiento deliberado:** antes, un `detected_requirements` con un id no declarado por el framework se aceptaba silenciosamente con `description: ""`. Ahora se **rechaza**. El test `evaluator.test.ts` que verificaba el comportamiento viejo fue reemplazado por uno que verifica el rechazo — ver `TESTS_ADDED`.

## SCORE_INTEGRITY

Implementado exactamente como el mínimo pedido: `0 <= overall_score <= framework.maxScore` y `0 <= criterion.score <= criterion.max_score`, más la validación adicional de `max_score === framework criterion.weight` (no pedida explícitamente pero necesaria para que "score integrity" signifique algo — sin esto, un `max_score` inventado por el modelo haría que cualquier `score` "estuviera en rango" trivialmente). No se inventó ninguna fórmula de scoring nueva.

---

## ELEVENLABS_POLICY

Sin cambios: `SIGNED_URL_TIMEOUT_MS = 10_000`, sin retry (la razón documentada en el código se mantiene: un fallo de `getSignedUrl` ya surge como 502 limpio, y reintentar todo `/session/start` es barato y seguro sin necesitar una política de retry separada aquí). Arquitectura `browser ↔ ElevenLabs` directa **sin cambios**.

## ELEVENLABS_RESPONSE_VALIDATION

`SignedUrlResponseSchema` (Zod, `{ signed_url: z.string().min(1) }`) valida el body de un `200`. Un `200` con body vacío, `{}`, o `signed_url` vacío/ausente ahora se rechaza como `ELEVENLABS_INVALID_RESPONSE` — antes se desestructuraba sin validar y podía propagar `signed_url: undefined` como si fuera éxito.

## ERROR_TAXONOMY (ElevenLabs)

Nueva clase `ElevenLabsError extends Error` con `.category`:
`ELEVENLABS_TIMEOUT`, `ELEVENLABS_NETWORK_ERROR`, `ELEVENLABS_RATE_LIMITED`, `ELEVENLABS_4XX`, `ELEVENLABS_5XX`, `ELEVENLABS_INVALID_RESPONSE`. El body crudo de una respuesta fallida sigue solo en `.message` (logueado, nunca persistido ni devuelto al cliente) — nunca en `.category`. El `signed_url` real nunca aparece en ningún error ni en el log estructurado (test dedicado lo verifica).

---

## FIRESTORE_FAILURE_POLICY

## MUST_SUCCEED_OPERATIONS
- `createSession` (`/session/start`) — único write en el critical path; si falla, la sesión nunca existió, 503.
- `claimSessionForEvaluation` (`/session/end`) — transaccional, si falla no se puede evaluar, 503.
- `persistCompletedResult` — si falla, Fase 4 ya cubre el caso ambiguo (ack perdido tras commit real) con recuperación explícita; si falla genuinamente, `markPersistenceFailed` deja la sesión en un estado reclamable.

## BEST_EFFORT_OPERATIONS
- `markEvaluationFailed` / `markPersistenceFailed` en las rutas de fail-closed de `/session/end` (legacy, resolution failed, hash mismatch, evaluatePitch failure) — el caller ya devuelve 503/502 exista o no la escritura. Se mantienen best-effort (correcto: no tiene sentido bloquear una respuesta de error en otro write que también puede fallar) pero **ninguno se traga el error en silencio ahora**: los 3 sitios que antes eran `.catch(() => {})` pasan por el nuevo helper `markEvaluationFailedLogged` (`routes.ts`), que loguea con `console.error` exactamente como ya hacía el cuarto sitio (evaluatePitch failure). Ese cuarto sitio se refactorizó para usar el mismo helper (elimina duplicación, no cambia comportamiento).

---

## STALE_EVALUATING_POLICY

Nueva función `listEvaluatingSessionsOlderThan(cutoffIso)` en `repositories/sessions.ts` — mismo patrón que `listInProgressSessionsOlderThan` (Fase 4), pero filtrando `status === "evaluating"` por `updated_at` (no se agregó ningún campo nuevo: `updated_at` ya se estampa exactamente en el momento en que `claimSessionForEvaluation` transiciona a `evaluating`).

## RECOVERY_SWEEP

`backend/scripts/mark-stale-evaluating-sessions.ts` — calco literal de `mark-abandoned-sessions.ts`:

```bash
npx tsx backend/scripts/mark-stale-evaluating-sessions.ts [--hours=2] [--dry-run]
# o: npm run sessions:mark-stale-evaluating -- [--hours=2] [--dry-run]
```

Default 2 horas (el peor caso real de una evaluación es ~1 minuto: 30s timeout × 2 intentos OpenRouter + 500ms backoff; 2h deja margen amplio). Cada candidata se transiciona vía `markEvaluationFailed(sessionId, "STALE_EVALUATION_TIMEOUT")` — la MISMA función guardada transaccionalmente que usa `/session/end`, así que una carrera real con un `/session/end` en curso (o con una segunda corrida del propio sweep) se resuelve igual que ya resuelve `mark-abandoned-sessions.ts` con `markAbandoned`: el guard rechaza si el status cambió, y el sweep la omite sin sobreescribir nada. No se agregó infraestructura de cron/scheduler — sigue siendo manual, igual que su predecesor.

---

## STRUCTURED_LOGGING

`backend/src/observability/log.ts` — `logEvent(fields: LogFields)` y `elapsedMs(startMs)`. Un evento por línea, JSON, a `console.log`. Eventos emitidos:

| Evento | Emisor | Campos clave |
|---|---|---|
| `openrouter_attempt` | `evaluator.ts` | `session_id`, `organization_id`, `config_version`, `scenario_id`, `attempt`, `duration_ms`, `outcome`, `error_category` |
| `evaluation_total` | `evaluator.ts` | igual, sin `attempt` |
| `elevenlabs_signed_url` | `elevenlabs.ts` | `duration_ms`, `outcome`, `error_category` (sin `session_id`: `getSignedUrl` corre antes de que exista el id de sesión) |
| `firestore_write` | `routes.ts` | `session_id`, `organization_id`, `config_version`, `scenario_id`, `duration_ms`, `outcome` — emitido para `createSession`, `claimSessionForEvaluation`, `persistCompletedResult` |

`session_id` sirve de correlation id en todos los eventos donde existe.

## REDACTION_POLICY

`LogFields` es una **whitelist cerrada de tipos**, no una convención: un `logEvent({...})` con un campo fuera de esa interfaz (una API key, `Authorization`, el `signed_url`, el service account, el transcript completo, el body crudo de un provider) falla el chequeo de excess-property de TypeScript en tiempo de compilación — no existe una pasada de "scrub por nombre de campo" en runtime que se pueda olvidar o saltar. Test dedicado (`elevenlabs.test.ts`) verifica además, en runtime, que el valor real del `signed_url` nunca aparece en el JSON logueado.

## LATENCY_MEASUREMENT

Medido: latencia por intento OpenRouter, latencia total de evaluación (incluye backoff), latencia `getSignedUrl` de ElevenLabs, y latencia de los 3 writes críticos de Firestore (`createSession`, `claimSessionForEvaluation`, `persistCompletedResult`). Dashboards quedan explícitamente para Fase 8.

---

## ERROR_TAXONOMY (consolidado)

**OpenRouter:** `OPENROUTER_TIMEOUT`, `OPENROUTER_NETWORK_ERROR`, `OPENROUTER_RATE_LIMITED`, `OPENROUTER_5XX`, `OPENROUTER_4XX`, `OPENROUTER_EMPTY_RESPONSE`, `OPENROUTER_INVALID_JSON`, `OPENROUTER_INVALID_RESPONSE_SCHEMA` (nueva), `OPENROUTER_INVALID_EVALUATION_CONTRACT` (nueva), `OPENROUTER_UNKNOWN_ERROR`.

**ElevenLabs:** `ELEVENLABS_TIMEOUT`, `ELEVENLABS_NETWORK_ERROR`, `ELEVENLABS_RATE_LIMITED`, `ELEVENLABS_4XX`, `ELEVENLABS_5XX`, `ELEVENLABS_INVALID_RESPONSE` (todas nuevas esta fase).

**Sesión:** `STALE_EVALUATION_TIMEOUT` (nueva, usada por el sweep) se suma a las ya existentes (`FIRESTORE_WRITE_FAILED`, `LEGACY_CONFIG_VERSION_UNKNOWN`, `CONFIG_VERSION_RESOLUTION_FAILED`, `CONFIG_PROVENANCE_HASH_MISMATCH`).

---

## FILES_CHANGED

**Nuevos:**
- `backend/src/services/evaluatorSchema.ts` + `.test.ts`
- `backend/src/observability/log.ts` + `.test.ts`
- `backend/scripts/mark-stale-evaluating-sessions.ts`

**Modificados:**
- `backend/src/services/evaluator.ts` / `.test.ts`
- `backend/src/services/elevenlabs.ts` / `.test.ts`
- `backend/src/repositories/sessions.ts` / `.test.ts`
- `backend/src/routes.ts` / `.test.ts`
- `backend/package.json` (nuevo script `sessions:mark-stale-evaluating`)

Sin cambios en frontend.

## TESTS_ADDED

40 tests nuevos (222 → 262 backend), TDD estricto (red confirmado antes de cada implementación):
- `evaluatorSchema.test.ts`: 17 — schema estructural + contrato semántico (unknown/missing/duplicate criterion y requirement, rangos, `max_score` vs `weight`).
- `evaluator.test.ts`: +7 — 2 nuevas categorías de error sin retry, reemplazo del test de comportamiento obsoleto (id desconocido ahora se rechaza, no se acepta con descripción vacía), 3 tests de logging.
- `elevenlabs.test.ts`: +8 — validación de response, 6 categorías de error, 2 tests de logging (incluye verificación de que el `signed_url` nunca se loguea).
- `sessions.test.ts`: +3 — `listEvaluatingSessionsOlderThan` (stale detectado, excluido si reciente, excluido si `in_progress`).
- `log.test.ts`: 4 — forma del JSON logueado, timestamp, omisión de campos ausentes, `elapsedMs`.
- `routes.test.ts`: +2 — normalización del catch silencioso (antes se tragaba, ahora loguea) + latencia de `createSession`.

## TEST_RESULTS

```
backend:  19 archivos, 262 tests, PASS
frontend:  2 archivos,   8 tests, PASS (sin cambios — Fase 7 no tocó frontend)
```

## BUILD

```
backend  tsc -p tsconfig.json          → PASS
frontend tsc -b && vite build          → PASS
```

---

## SECURITY_IMPACT

Ninguno negativo. La validación de contrato del evaluator es estrictamente más estricta que antes (rechaza lo que antes se aceptaba silenciosamente), lo cual reduce superficie de datos no confiables persistidos. La redacción por tipos en `LogFields` es una mejora de postura, no una regresión. El incidente de Firestore real (ver arriba) fue una lectura, no una escritura — impacto de seguridad nulo pero sí una violación de proceso que se reporta explícitamente.

## MULTITENANT_IMPACT

Ninguno. No se tocó ningún path de resolución de tenant/organización; `organization_id` se agregó solo como campo de correlación en logs, siempre leído del contexto ya resuelto (`req.appContext`/`claim.session`), nunca del body.

## TECH_DEBT_INTRODUCED

Ninguna nueva deliberada. `mark-stale-evaluating-sessions.ts` no tiene test de integración end-to-end contra Firestore real (igual que su predecesor `mark-abandoned-sessions.ts`, que tampoco lo tenía) — su lógica de lectura (`listEvaluatingSessionsOlderThan`) sí está cubierta.

## KNOWN_LIMITATIONS

- El sweep de stale-evaluating sigue siendo manual (sin cron), igual que el de abandoned — decisión deliberada, coherente con el alcance de esta fase.
- `structured logging` va a `console.log`/`console.error` únicamente — sin agregación ni dashboards (Fase 8).
- La validación semántica del evaluator no cubre `duration_policy` ni bandas de scoring de duración — el campo `duration` se valida estructuralmente (Zod) pero no semánticamente contra `framework.durationPolicy`. No estaba en el alcance pedido para esta fase.

## DEFERRED_TO_PHASE_08

Dashboards/alerting sobre los eventos estructurados, rate limiting más allá del limiter existente, cualquier plataforma externa de observabilidad (Sentry/Datadog), scheduling del sweep.

## OPEN_ITEMS

Ninguno bloqueante para cerrar Fase 7.

---

## ENTREGA

1. **Commit SHA de código:** `eb9f2ab696a37d28507fc028fbbc03c30f4e3fc9`.
2. **Commit SHA de este reporte:** el siguiente commit en el historial (este archivo se commitea por separado, después de este).
3. **Resumen de cambios:** ver `WHAT_CHANGED`.
4. **Tests exactos:** ver `TEST_RESULTS` (262/262 backend, 8/8 frontend).
5. **Build exacto:** ver `BUILD` (ambos PASS).
6. **Dependency inventory:** ver `DEPENDENCY_INVENTORY`.
7. **Error taxonomy:** ver `ERROR_TAXONOMY`.
8. **Timeout/retry policy:** ver `OPENROUTER_POLICY` / `ELEVENLABS_POLICY` (sin cambios de valores, confirmados contra código real).
9. **Evaluator validation contract:** ver `EVALUATOR_RUNTIME_VALIDATION` / `EVALUATOR_SEMANTIC_VALIDATION`.
10. **Stale evaluating recovery policy:** ver `STALE_EVALUATING_POLICY`.
11. **Structured logging/redaction:** ver `STRUCTURED_LOGGING` / `REDACTION_POLICY`.
12. **Deuda explícita para Fase 8:** ver `DEFERRED_TO_PHASE_08`.

**No deploy. No Firestore real** (salvo la lectura accidental declarada arriba, sin escritura). **No Fase 8.**
