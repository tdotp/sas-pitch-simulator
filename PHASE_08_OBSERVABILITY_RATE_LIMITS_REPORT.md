# PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 8 de 15 — OBSERVABILITY + RATE LIMITS
**Commit base aprobado (Fases 1–7, cerradas):** `03fa0825c3204423b4ef7f09929357b0944e2b0f`
**Código de esta fase:** `079eda8a8ac982d1fa93bdedb015cf1ff33c7bbc`
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado. NO Firestore real.**

---

## WHAT_CHANGED

- **`request_id`** por request HTTP (`middleware/requestId.ts`), generado server-side, montado como lo primero en el router.
- **HTTP request logging** (`middleware/requestLogging.ts`): un evento `http_request` por request, emitido en `res.on("finish")`.
- **Rate limiting server-side, tenant/user/endpoint-aware** (`middleware/rateLimit.ts`): límites independientes por usuario, organización y global, para `/session/start`, `/session/end` y `/metrics/analyze`. Nunca usa `req.body` como key — solo `req.auth.uid`/`req.appContext.organizationId`, resueltos server-side.
- **Log normalization**: `config_integrity_failure` (LEGACY_CONFIG_VERSION_UNKNOWN, CONFIG_VERSION_RESOLUTION_FAILED, CONFIG_PROVENANCE_HASH_MISMATCH) y `session_recovery` (STALE_EVALUATION_TIMEOUT) — los console.error ya existentes de Fase 6/7 ahora TAMBIÉN emiten un evento estructurado.
- **Observability summarizer** (`scripts/observability-summarize.ts` + `scripts/observabilitySummarize.ts`): CLI offline que agrega JSON-lines en counts/p50/p95/max/error-rate, sin infraestructura nueva.
- **Error correlation**: `request_id` opcional threadeado hacia `evaluatePitch`/`getSignedUrl`, presente en `openrouter_attempt`, `evaluation_total` y `elevenlabs_signed_url` cuando la llamada se originó desde un request HTTP conocido.
- **`LogFields`** (observability/log.ts) extendido con `request_id`, `user_id`, `role`, `method`, `endpoint`, `status_code`, `rate_limit_scope`.

No se tocó: evaluator validation, session lifecycle, config versioning, tenant isolation/RBAC, provider timeout/retry policies (todo Fase 1–7 se mantiene intacto — ver TEST_RESULTS). Sin cambios en frontend.

---

## CURRENT_OBSERVABILITY_AUDIT

Auditoría hecha ANTES de tocar código (paso 1 obligatorio), sobre el estado real al cierre de Fase 7:

**`logEvent(...)` ya estructurados (6 call sites):** `routes.ts` (createSession/claimSessionForEvaluation/persistCompletedResult — evento `firestore_write`), `services/evaluator.ts` (`openrouter_attempt`/`evaluation_total`), `services/elevenlabs.ts` (`elevenlabs_signed_url`).

**`console.log` (texto libre, 9 sitios):** `firebase.ts` (3, arranque), `index.ts` (2, arranque), `repositories/sessions.ts` (4, transiciones de estado — ya duplican la info que `firestore_write` cubre desde otro ángulo, se dejan como están, son diagnóstico de desarrollo).

**`console.warn` (5 sitios):** `firebase.ts`, `routes.ts` (1: `markEvaluationFailed no se aplicó`), `repositories/sessions.ts` (3: mismos "no se aplicó" para los 3 guarded exits). Ninguno normalizado esta fase — son best-effort ya explicados por Fase 7, no forman parte de los 5 ejemplos explícitos del punto 7 del kickoff.

**`console.error` (19 sitios):** de estos, exactamente los 4 que el kickoff nombra explícitamente como candidatos a normalizar (`LEGACY_CONFIG_VERSION_UNKNOWN`, `CONFIG_VERSION_RESOLUTION_FAILED`, `CONFIG_PROVENANCE_HASH_MISMATCH` en `routes.ts`, más `STALE_EVALUATION_TIMEOUT` en el script de sweep) se normalizaron con un evento estructurado adicional. Los demás (`firebase.ts` init failures, `repositories/*.ts` "documento con forma inválida", `middleware/context.ts` resolve() failure) se dejan sin tocar — no listados explícitamente y "no es obligatorio eliminar todos" ni normalizar todos.

**Rate limiter existente:** un único `express-rate-limit` global (`routes.ts`, `router.use(requireToken, limiter)`), **IP-based** (default de la librería), **20 req/min**, aplicado a TODAS las rutas después de `/health` — incluyendo `/me` y `/admin/sessions` (baratas) con el MISMO límite que `/session/start`/`/session/end` (caras). Sin distinción de usuario, organización ni endpoint. `/health` queda fuera por estar declarado antes del `router.use(...)`.

**Endpoints reales confirmados en `routes.ts`** (no asumidos): `GET /health` (sin auth), `POST /session/start`, `POST /session/end`, `POST /metrics/analyze`, `GET /admin/sessions`, `GET /me` — todos montados bajo `/api` (`index.ts`).

**Deployment real:** `index.ts` corre un único `app.listen(...)`, sin cluster ni workers — confirma que in-memory es válido para `RATE_LIMIT_STORAGE_DECISION` (ver esa sección).

---

## EVENT_TAXONOMY

Mantiene los 4 eventos de Fase 7 (`openrouter_attempt`, `evaluation_total`, `elevenlabs_signed_url`, `firestore_write`) sin cambios de forma, solo con campos adicionales cuando aplica (`request_id`). Nuevos, todos familias estables (no un evento por mensaje):

| Evento | Emisor | Cuándo |
|---|---|---|
| `http_request` | `middleware/requestLogging.ts` | Al terminar CADA request (`res.on("finish")`) |
| `rate_limit_rejected` | `middleware/rateLimit.ts` | Cada vez que un limiter (user/organization/global) rechaza con 429 |
| `config_integrity_failure` | `routes.ts` | LEGACY_CONFIG_VERSION_UNKNOWN / CONFIG_VERSION_RESOLUTION_FAILED / CONFIG_PROVENANCE_HASH_MISMATCH, diferenciados por `error_category` |
| `session_recovery` | `scripts/mark-stale-evaluating-sessions.ts` | Cuando el sweep realmente transiciona una sesión (no en `--dry-run`) |

---

## COMMON_LOG_FIELDS

`LogFields` (`observability/log.ts`) es la whitelist de tipos completa ahora:

```ts
event, session_id, organization_id, config_version, scenario_id, provider,
attempt, duration_ms, outcome, error_category,
request_id, user_id, role, method, endpoint, status_code, rate_limit_scope
```

`user_id` es siempre el uid técnico de Firebase (`req.auth.uid`), nunca el email — verificado: ningún call site nuevo pasa `req.auth.email`. Sin `rate_limit_key` (deliberado: `user_id`/`organization_id`/`endpoint`/`rate_limit_scope` ya identifican la key sin necesidad de loguearla cruda). Test dedicado (`routes.test.ts`) verifica que un evento `http_request` real nunca contiene el header `Authorization`, el body, ni un transcript, comprobando además que sus keys son un subconjunto exacto de `LogFields`.

---

## REQUEST_ID_POLICY

Generado 100% backend-side (`crypto.randomUUID()`, `middleware/requestId.ts`) — nunca se confía en un header del cliente (un id que el caller propone no es una key de correlación confiable). Montado como el PRIMER middleware del router (`router.use(requestId, requestLogging)`), antes de `/health` — disponible para cualquier handler vía `req.id`. Convive con `session_id`: ambos son campos independientes en `LogFields`, ninguno reemplaza al otro. No se implementó tracing distribuido (no hace falta — un solo proceso backend).

---

## HTTP_REQUEST_LOGGING

Un evento `http_request` por request (`middleware/requestLogging.ts`), emitido en `res.on("finish")` para que `status_code` y `duration_ms` sean los finales. Campos: `request_id`, `method`, `endpoint` (=`req.path`, sin query string), `status_code`, `duration_ms`, `organization_id`/`user_id`/`role` si ya estaban resueltos en ese momento (p. ej. un 401 antes de `requireMembership` no los tiene — verificado por test), `outcome` (`status_code < 400 ? "success" : "failure"`). Nunca lee `req.body`, `req.headers`, ni la query string.

---

## ERROR_CORRELATION

`evaluatePitch()` y `getSignedUrl()` aceptan un `requestId` opcional (threadeado desde `req.id` en `routes.ts`); cuando está presente aparece en `openrouter_attempt`, `evaluation_total` y `elevenlabs_signed_url`. Combinado con `session_id`/`organization_id`, ya presentes desde Fase 7, un fallo de provider es correlacionable por las tres dimensiones cuando existen. No se modificó ninguna clase de `Error` — la correlación vive enteramente en los campos de los logs estructurados, tal como pedía el punto 6.

---

## REDACTION_POLICY

Sin cambios de fondo respecto al addendum de Fase 7 (P2): `LogFields` es una whitelist tipada, no una garantía de runtime. Nuevo, verificado con test explícito: el evento `http_request` de un request con `Authorization: Bearer <token-secreto>` y un `transcript` en el body nunca contiene ninguno de los dos valores, y sus keys son exactamente un subconjunto de `LogFields` — protección por construcción (la función solo LEE `req.method`/`req.path`/`res.statusCode`/campos ya resueltos, nunca `req.body` ni `req.headers`), no por un scrubber.

---

## OBSERVABILITY_SUMMARIZER

`backend/scripts/observabilitySummarize.ts` (lógica pura, testeada) + `backend/scripts/observability-summarize.ts` (wrapper CLI, lee archivo o stdin):

```bash
npm run observability:summarize -- app.log
cat app.log | npm run observability:summarize --
```

Produce: `request_count`, `success_count`, `error_count`, `error_rate`, `rate_limited_count`, `provider_failure_count`, `evaluations.{success,failure}`, `requests_by_endpoint`, `organization_traffic`, `error_count_by_category`, y latencias `{p50,p95,max,count}` por endpoint/provider/evento. Nunca lanza excepción — una línea que no parsea como JSON, que no es un objeto, o a la que le falta `event`, se cuenta en `malformed_lines` y se salta. Sin storage nuevo, sin conexión a producción. Ejemplo real de salida contra un fixture de 4 líneas (incluyendo una malformada):

```json
{
  "total_lines": 4, "malformed_lines": 1,
  "request_count": 1, "success_count": 1, "error_count": 0, "error_rate": 0,
  "rate_limited_count": 1, "provider_failure_count": 1,
  "evaluations": { "success": 0, "failure": 0 },
  "requests_by_endpoint": { "/me": 1 },
  "error_count_by_category": { "OPENROUTER_TIMEOUT": 1 },
  "latency_by_provider": { "openrouter": { "count": 1, "p50": 30000, "p95": 30000, "max": 30000 } }
}
```

---

## RATE_LIMIT_INVENTORY

Rutas reales confirmadas (no asumidas — ver CURRENT_OBSERVABILITY_AUDIT):

| Endpoint | Costo real | Límites nuevos |
|---|---|---|
| `GET /health` | Ninguno (sin auth, sin provider) | Ninguno — ver HEALTH_ENDPOINT |
| `GET /me` | Bajo (Firestore) | Ninguno nuevo — cubierto por el limiter IP global existente |
| `GET /admin/sessions` | Bajo (Firestore) | Ninguno nuevo — ídem |
| `POST /metrics/analyze` | Bajo (cómputo local, sin llamada externa) | user-scoped, 1 tier |
| `POST /session/start` | **Alto** (ElevenLabs signed-url) | user + organization + global |
| `POST /session/end` | **Alto** (OpenRouter, hasta 2 intentos × 30s) | user + organization + global |

---

## RATE_LIMIT_STORAGE_DECISION

In-memory (`Map` por proceso, `middleware/rateLimit.ts`) — NO Redis. Verificado, no asumido: `backend/src/index.ts` corre un único `app.listen(...)`, sin `cluster`/workers, sin evidencia de múltiples instancias en el deployment actual. Un único proceso hace que un `Map` in-memory sea exactamente tan consistente como necesita ser. Si una fase futura mueve el backend a múltiples instancias, esta decisión necesita revisarse — no se introduce Redis especulativamente ahora.

---

## RATE_LIMIT_KEY_STRATEGY

Nunca IP-only. `keyOf` deriva la key de estado ya verificado server-side:
- **user**: `req.auth.uid` (poblado por `requireAuth`) — nunca del body.
- **organization**: `req.appContext.organizationId` (poblado por `requireMembership` desde el Membership real) — nunca `body.organization_id`.
- **global**: key fija, un solo bucket por endpoint.

Test de regresión obligatorio (`TENANT_TRUST_BOUNDARY`, en `rateLimit.test.ts` y en `routes.test.ts` contra la ruta real): un request con `body.organization_id = "org-B"` y contexto real `org-A` cuenta EXCLUSIVAMENTE contra el bucket de `org-A`; un caller genuino de `org-B` nunca ve su bucket afectado por ese intento.

---

## USER_LIMITS / ORGANIZATION_LIMITS / GLOBAL_LIMITS

Defaults — **estimaciones conservadoras, NO datos de load test** (no existe evidencia de uso real todavía) — todos overrideables por env sin cambio de código:

| Endpoint | User/min | Org/min | Global/min | Env vars |
|---|---|---|---|---|
| `/session/start` | 6 | 30 | 120 | `RATE_LIMIT_SESSION_START_{USER,ORG,GLOBAL}_PER_MIN` |
| `/session/end` | 4 | 20 | 80 | `RATE_LIMIT_SESSION_END_{USER,ORG,GLOBAL}_PER_MIN` |
| `/metrics/analyze` | 30 | — | — | `RATE_LIMIT_METRICS_ANALYZE_USER_PER_MIN` |

Justificación: `/session/end` es más cara que `/session/start` (una evaluación OpenRouter puede tardar hasta ~60s en el peor caso con retry, vs. una llamada ElevenLabs de 10s) — por eso su límite de usuario es más bajo, no el mismo por comodidad. `/metrics/analyze` no cuesta un proveedor externo, así que solo tiene tier de usuario (evita spam/loop de un cliente, no protege un proveedor). **Requieren tuning bajo carga real — documentado explícitamente, no una promesa de que estos números son correctos.**

---

## COST_AWARE_POLICY

No se construyó billing. El diseño SÍ reconoce que `/session/end` > `/session/start` > `/metrics/analyze` en costo (ver tabla de límites arriba, deliberadamente asimétrica) y que ambos endpoints "caros" tienen protección de 3 niveles (user/org/global) mientras que el "barato" solo tiene una.

## GLOBAL_LIMITS (safety cap)

Un bucket único por endpoint, independiente de usuario/organización — un techo de seguridad tipo circuit-breaker (nunca decide en base a la salud del provider, solo volumen de requests; NO es un circuit breaker completo, eso queda para una fase futura si el punto 20 muestra que hace falta).

---

## HTTP_429_POLICY

Body genérico: `{ error: "Demasiadas solicitudes. Intenta de nuevo más tarde.", retry_after_seconds: N }`. Nunca revela otras organizaciones, límites internos completos, ni identificadores sensibles — solo el segundo de espera.

## RETRY_AFTER_POLICY

Header `Retry-After` (segundos hasta que el bucket se reinicia) añadido en cada rechazo — cálculo simple y coherente con el body (`retry_after_seconds`), verificado por test.

---

## RATE_LIMIT_LOGGING

Cada rechazo emite `rate_limit_rejected`: `request_id`, `user_id`, `organization_id`, `endpoint`, `rate_limit_scope`, `outcome: "failure"`. Deliberadamente SIN `rate_limit_key` cruda — los 4 campos anteriores ya identifican el rechazo sin necesidad de loguear la key compuesta.

---

## MULTITENANT_IMPACT

Ninguno negativo — reforzado. La organización SIEMPRE se lee de `req.appContext.organizationId` (nunca del body) tanto para rate limiting como para el logging nuevo; verificado con el test `TENANT_TRUST_BOUNDARY` explícito contra la ruta real, no solo contra el primitivo.

## SECURITY_IMPACT

Positivo: cierra el gap real encontrado en la auditoría (un único limiter IP-based, sin distinción de usuario/organización/endpoint, protegía `/session/start`/`/session/end` con el MISMO presupuesto que `/me`). El limiter IP-based existente se mantiene intacto como capa adicional (defensa en profundidad para rutas pre-auth), no se elimina. Ningún secreto/transcript/header sensible se agrega a ningún log nuevo — verificado con tests explícitos, no solo por inspección.

---

## HEALTH_ENDPOINT

Revisado — sin cambios. `/health` sigue siendo barato: reporta `assertElevenReady()`/`assertOpenRouterReady()` (chequeos de config, ninguna llamada real a ElevenLabs/OpenRouter) y `isAuthReady()` (estado ya resuelto de Firebase Admin). No se convirtió en un monitor profundo.

## AUTH_ROUTES / PRE-AUTH LIMITING

El limiter IP-based global (`router.use(requireToken, limiter)`, Fase 1) ya cubre exactamente este caso (protección básica antes de que exista uid/organización) — se deja como está, sin cambios, satisface el punto 19 sin necesitar nada nuevo.

## PROVIDER_FAILURE_BURSTS

No se implementó circuit breaker. `openrouter_attempt`/`elevenlabs_signed_url` ya loguean `outcome`+`error_category` por intento (Fase 7); el summarizer agrupa por `error_count_by_category`, suficiente para que un operador vea un burst de `OPENROUTER_RATE_LIMITED` o `ELEVENLABS_5XX` corriendo el CLI sobre el log. Decisión de si hace falta un circuit breaker queda explícitamente para una fase futura si los datos reales lo justifican.

---

## FILES_CHANGED

**Nuevos:** `middleware/requestId.ts`, `middleware/requestLogging.ts`, `middleware/rateLimit.ts` + `.test.ts`, `scripts/observabilitySummarize.ts` + `.test.ts`, `scripts/observability-summarize.ts`.

**Modificados:** `config.ts` (rateLimits), `observability/log.ts` (+`.test.ts`, LogFields extendido), `routes.ts` (+`.test.ts`: wiring de request-id/logging/rate-limits/config_integrity_failure), `services/evaluator.ts`/`.test.ts` (requestId opcional), `services/elevenlabs.ts`/`.test.ts` (requestId opcional), `scripts/mark-stale-evaluating-sessions.ts` (evento `session_recovery`), `package.json` (script `observability:summarize`).

Sin cambios en frontend.

## TESTS_ADDED

42 tests nuevos (274 → 316), TDD estricto con RED confirmado antes de cada implementación:
- `middleware/rateLimit.test.ts`: 11 — primitivo scoped limiter, tenant trust boundary, factories.
- `routes.test.ts`: +21 — HTTP observability (5), rate limiting wiring incluyendo tenant trust boundary contra la ruta real (7), config_integrity_failure (2, +1 assertion en test existente).
- `scripts/observabilitySummarize.test.ts`: 12 — counts, grouping, p50/p95/max, malformed lines, líneas incompletas, input vacío.
- `services/evaluator.test.ts`: +2, `services/elevenlabs.test.ts`: +2 — request_id correlation.
- `observability/log.test.ts`: +1 — nuevos campos.

## TEST_RESULTS

```
backend:  22 archivos, 316 tests, PASS (verificado 3 corridas consecutivas)
frontend:  2 archivos,   8 tests, PASS (sin cambios)
```

## BUILD_RESULTS

```
backend  tsc -p tsconfig.json          → PASS
frontend tsc -b && vite build          → PASS
```

---

## KNOWN_LIMITATIONS

- Los defaults de rate limit son estimaciones, no datos de carga real — requieren tuning (ver USER_LIMITS).
- `scripts/mark-stale-evaluating-sessions.ts` no tiene test dedicado para su nuevo `logEvent` (mismo patrón/limitación que su script hermano `mark-abandoned-sessions.ts`, sin tests desde Fase 7 — importar el script ejecuta `main()`, igual que antes).
- La limpieza periódica de buckets vencidos en `rateLimit.ts` (sweep cada 5 min) no está testeada por temporizador real — su lógica de expiración por ventana SÍ está cubierta (`resets after the window elapses`).
- `console.log`/`console.warn` de `repositories/sessions.ts` y `firebase.ts`/`index.ts` no se normalizaron — deliberado, no listados en el punto 7 del kickoff.

## DEFERRED_TO_PHASE_09

Circuit breaker completo, dashboards/alerting reales, Redis (si el deployment real deja de ser single-instance), tuning de límites con datos de carga real, cualquier plataforma externa.

## OPEN_ITEMS

Ninguno bloqueante para cerrar Fase 8.

---

## ENTREGA

1. **Commit SHA de código:** `079eda8a8ac982d1fa93bdedb015cf1ff33c7bbc`.
2. **Commit SHA de este reporte:** el siguiente commit en el historial.
3. **Resumen:** ver `WHAT_CHANGED`.
4. **Tests exactos:** ver `TEST_RESULTS` (316/316 backend, 8/8 frontend).
5. **Build exacto:** ver `BUILD_RESULTS` (ambos PASS).
6. **Observability audit:** ver `CURRENT_OBSERVABILITY_AUDIT`.
7. **Event taxonomy:** ver `EVENT_TAXONOMY`.
8. **Request-id policy:** ver `REQUEST_ID_POLICY`.
9. **Rate-limit storage decision:** ver `RATE_LIMIT_STORAGE_DECISION`.
10. **Rate-limit key strategy:** ver `RATE_LIMIT_KEY_STRATEGY`.
11. **Límites por endpoint/scope y justificación:** ver `USER_LIMITS / ORGANIZATION_LIMITS / GLOBAL_LIMITS` + `COST_AWARE_POLICY`.
12. **HTTP 429 policy:** ver `HTTP_429_POLICY` / `RETRY_AFTER_POLICY`.
13. **Summarizer output example:** ver `OBSERVABILITY_SUMMARIZER`.
14. **Seguridad/multitenancy impact:** ver `SECURITY_IMPACT` / `MULTITENANT_IMPACT`.
15. **Deuda explícita para Fase 9:** ver `DEFERRED_TO_PHASE_09`.

**No deploy. No Firestore real. No Fase 9.**
