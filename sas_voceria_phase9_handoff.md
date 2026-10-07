# SAS VOCERIA — CONTEXT HANDOFF / START PROMPT (post Fase 9)

## 1. ROL DEL NUEVO CHAT

Actúa como **arquitecto técnico, reviewer, QA y auditor** del proyecto SAS VOCERIA. Este chat comienza con las Fases 1–8 aprobadas y cerradas, y con la Fase 9 (Tests / Quality Gate) **implementada, con una ronda de PASS_WITH_FIXES ya corregida, y pendiente de tu revisión formal**. Tu primera tarea es revisar Fase 9 (ver sección 12).

Tu función **no es implementar ni commitear código**. Otro agente ejecutor hará los cambios. Tu trabajo:

```
definir la siguiente fase
→ revisar la implementación real (commits, no resúmenes)
→ inspeccionar GitHub
→ detectar P0/P1/P2/P3
→ pedir fixes cuando corresponda
→ cerrar formalmente cada fase
```

No confíes únicamente en los resúmenes del agente ejecutor. Cuando entregue código: revisa los commits reales, inspecciona los archivos relevantes, verifica tests y contratos, busca regresiones, comprueba seguridad y multitenancy, decide PASS / PASS_WITH_FIXES / FAIL.

No hagas deploy. No escribas en producción. No modifiques Firestore real sin autorización explícita. No implementes código por tu cuenta.

## 2. REPOSITORIO Y BRANCH

- **Repo:** `tdotp/sas-pitch-simulator` (GitHub, remote `origin`)
- **Branch por defecto:** `master`
- **Deployment backend:** Docker Compose — Caddy (único servicio con puertos públicos 80/443) → backend (`expose: "8080"` solamente, inalcanzable directamente desde fuera de la red docker `sas-net`). Un único reverse proxy real delante del backend.
- **Deployment frontend:** Firebase Hosting (`smartpr-pitch-agent.web.app` / `smartpr-pitch-agent.firebaseapp.com`).
- **Stack backend:** Node, Express, TypeScript, Firestore, Firebase Admin/Auth, OpenRouter, ElevenLabs Conversational AI.
- **Stack frontend:** React, Vite, TypeScript, Firebase Hosting.
- **Arquitectura de voz:** `browser ↔ ElevenLabs` WebSocket directo — **no cambiar sin evidencia fuerte**.

## 3. OBJETIVO ARQUITECTÓNICO

Convertir un MVP funcional de entrenador de vocería en una plataforma multi-cliente:

```
PLATFORM CORE
+ ORGANIZATION
+ CLIENT CONFIG
+ INTERVIEWER CONFIG
+ SCENARIO CONFIG
+ EVALUATION CONFIG
= CLIENT EXPERIENCE
```

Objetivo de onboarding: `create organization → load/version content → validate → QA → activate`, sin repos duplicados, branches por cliente, hardcodes por cliente, rubrics/prompts hardcodeados, ni deploy nuevo por contenido.

## 4. INVARIANTES DE SEGURIDAD Y MULTITENANCY (vigentes, no negociables)

- Firebase Auth es la única autoridad de identidad; identidad nunca viene del body.
- Organization + Membership son la autoridad de tenant/rol — nunca `organizationId`/`role` del body o del frontend.
- Roles vigentes: `AGENCY_ADMIN`, `CLIENT_ADMIN`, `COACH`, `SPOKESPERSON`.
- `AGENCY_ADMIN` **no** es superusuario global — solo ve organizaciones donde tiene Membership real, activa.
- El backend deriva tenant/identity exclusivamente desde auth verificado + Membership persistido en Firestore.
- Ownership de recursos (sesiones, etc.) siempre verificado server-side contra el estado persistido, nunca confiado del cliente.
- Cross-tenant access falla cerrado (404 uniforme, nunca revela existencia de un recurso de otro tenant).
- Rate limiting: keys tenant-aware vienen EXCLUSIVAMENTE de `req.auth.uid` / `req.appContext.organizationId` (contexto server-side resuelto), nunca del body.

## 5. ESTADO CERRADO FASE POR FASE

**Fase 1 — AUTH:** Firebase Auth frontend + bearer token backend, verificación server-side (`admin.auth().verifyIdToken`). Sin `APP_USERS` en plano, sin `x-app-token` compartido como mecanismo de seguridad (solo anti-abuse). Identidad nunca del body. Init de auth separado del init de persistencia.

**Fase 2 — ORGANIZATION/MEMBERSHIP/ROLES:** Modelos `Organization`, `Membership`, `AppUser`, `Role`. `GET /me` resuelve contexto real desde Firestore. Multi-membership ambiguo → 409 explícito con lista de orgs elegibles, nunca se elige arbitrariamente. Estados `inactive` se respetan en toda la cadena (AppUser + Membership + Organization).

**Fase 3 — TENANT ISOLATION + RBAC:** Toda ruta sensible requiere `requireAuth` + `requireMembership`. Ownership y organización se verifican contra el estado PERSISTIDO, nunca contra lo que el cliente afirma. `/admin/sessions` tenant-scoped. `SPOKESPERSON` sin acceso administrativo. Cross-tenant access falla cerrado con 404 uniforme.

**Fase 4 — SESSION LIFECYCLE (final):** State machine explícita:
```
in_progress → evaluating → completed
evaluating → evaluation_failed
evaluating → persistence_failed
in_progress → abandoned
```
`claimSessionForEvaluation` transaccional (ownership + tenant + concurrencia + idempotencia, una sola evaluación real por sesión). Guarded exits desde `evaluating` (`applyFromEvaluating`): nunca sobreescriben `completed`. Recuperación de ambiguous-commit (ack perdido tras write real) implementada. OpenRouter timeout/retry nace aquí, formalizado en Fase 7.

**Fase 5 — ENGINE vs CONFIG:** Separación real: el engine nunca conoce clientes concretos. Modelo `ClientConfig`, `Scenario`, `InterviewerProfile`, `EvaluationFramework`, `ContentSource`, paquetes en `backend/config-packages/<organization>/<version>/`. `TargetMode` ya no es enum cerrado (wire legacy = scenarioId dentro de la org). Requirements 100% config-driven — `EvaluationFramework.requirements[]` → `detected_requirements[]` con `{id, description, detected, evidence}`, `description` siempre desde config, nunca del LLM. Sin campos universales client-specific en el engine (nada como `mentioned_sas` hardcodeado). Selector de escenarios en frontend sigue estático — onboarding no-code end-to-end queda pendiente para fase futura (no bloqueante, documentado).

**Fase 6 — VERSIONING + PROVENANCE (final):** `ConfigPackageVersion` con estados `draft|active|deprecated`, máximo 1 `active` por organización, `deprecated` sigue resolviendo sesiones históricas. Sin `pickVersionDir().sort().reverse()` en ningún lado. Dos funciones separadas: `resolveScenarioConfigForNewSession` (consulta la versión ACTIVE) vs `resolveScenarioConfigForVersion` (versión pinneada exacta, sin tocar el registro). `SessionRecord.config_provenance` (`config_version`, `interviewer_profile_id`, `evaluation_framework_id`, `content_source_ids`, `config_hash`) escrito UNA vez en `/session/start`, nunca re-derivado. **Hash enforcement es precondición real, no metadata pasiva:** para `/session/end`, `resolved.configHash === session.config_provenance.config_hash` es obligatorio — mismatch → `CONFIG_PROVENANCE_HASH_MISMATCH`, 503, evaluator nunca corre, provenance nunca se re-pinnea. Sesiones legacy pre-Fase-6 (sin `config_version`) → `LEGACY_CONFIG_VERSION_UNKNOWN`, fail-closed, nunca se adivina versión (migración es Fase 10). `manifest.status` NO es autoridad operacional — el Config Version Registry sí. CLI reproducible: `npm run config:validate/import/activate`.

**Fase 7 — RELIABILITY / PROVIDER HARDENING:** Runtime + semantic validation del evaluator vía Zod (`evaluatorSchema.ts`: `LlmEvaluationResponseSchema` estructural + `validateEvaluationContract` semántica contra el `EvaluationFramework` PINNEADO — cobertura exacta de criteria/requirements, sin ids desconocidos/faltantes/duplicados, `max_score === framework.weight`, rangos de score). Reemplaza el antiguo `JSON.parse(...) as EvaluationResult` sin validar. Error taxonomy: OpenRouter (+`OPENROUTER_INVALID_RESPONSE_SCHEMA`, `OPENROUTER_INVALID_EVALUATION_CONTRACT`), ElevenLabs (`ELEVENLABS_TIMEOUT/NETWORK_ERROR/RATE_LIMITED/4XX/5XX/INVALID_RESPONSE`, incluyendo un 200 con JSON malformado/HTML fail-closed). Políticas de provider **sin cambios de valores**: OpenRouter 30s/intento, máx 1 retry, 500ms backoff, retryable en 429/5xx/timeout/red, no retryable en 4xx; ElevenLabs 10s timeout, sin retry (deliberado). Stale evaluating recovery: `listEvaluatingSessionsOlderThan` + `scripts/mark-stale-evaluating-sessions.ts` (`--hours=N --dry-run`, reutiliza `updated_at` y `markEvaluationFailed`, `--hours` validado finito>0 ANTES de tocar Firebase). Structured logging (`observability/log.ts`): `LogFields` es una **whitelist tipada** (NO una garantía de runtime — un objeto construido dinámicamente o via variable intermedia la evade; wording corregido explícitamente tras revisión). Eventos: `openrouter_attempt`, `evaluation_total`, `elevenlabs_signed_url`, `firestore_write`. Los `.catch(() => {})` silenciosos de `markEvaluationFailed` en `routes.ts` ahora todos loguean, ninguno traga errores en silencio.

**Fase 8 — OBSERVABILITY + RATE LIMITS (final, 3 rondas de PASS_WITH_FIXES cerradas):** `request_id` generado 100% backend-side por request (`middleware/requestId.ts`), montado primero en el router. Evento `http_request` estructurado al terminar cada request (`middleware/requestLogging.ts`, `res.on("finish")`) — nunca loguea body/headers/Authorization/transcript (verificado por test). Rate limiting server-side tenant-aware (`middleware/rateLimit.ts`, primitivo `scopedRateLimit` in-memory) para `/session/start`, `/session/end`, `/metrics/analyze` — scopes `user` + `organization` + `global`, keys exclusivamente de `req.auth.uid`/`req.appContext.organizationId` (test de tenant-trust-boundary explícito: un `body.organization_id` spoofeado nunca afecta el bucket). Storage in-memory grounded en deployment real (proceso único, sin cluster — no Redis). Defaults (estimaciones conservadoras, no load-tested, todas overrideables por env): `/session/start` 6/30/120 (user/org/global por min), `/session/end` 4/20/80, `/metrics/analyze` 30 user-only. HTTP 429 con body genérico + `retry_after_seconds` + header `Retry-After`. Evento `rate_limit_rejected` en todo rechazo. Log normalization: eventos `config_integrity_failure` (LEGACY_CONFIG_VERSION_UNKNOWN/CONFIG_VERSION_RESOLUTION_FAILED/CONFIG_PROVENANCE_HASH_MISMATCH) y `session_recovery` (STALE_EVALUATION_TIMEOUT) añadidos junto a los `console.error` ya existentes. Observability summarizer offline (`scripts/observability-summarize.ts`, lee archivo/stdin, nunca lanza excepción, nearest-rank real `p50/p95/max` = `ceil(p*n)-1`). Error correlation: `request_id` opcional threadeado hacia `evaluatePitch`/`getSignedUrl`. **IP safety cap** (pre-auth, reemplaza el viejo limiter `express-rate-limit` que dominaba por estar por debajo de los límites de organización): `ipScopedLimiter`, default **300/min**, grounded > todo límite de organización/usuario existente. **Trust proxy:** `app.set("trust proxy", 1)` vía `TRUSTED_PROXY_HOPS` (`trustProxy.ts`), grounded en `internet → Caddy (único puerto público) → backend (solo expose)` — sin esto, `req.ip` sería siempre la IP de Caddy para todo el tráfico, colapsando el bucket de IP en uno solo compartido.

## 5b. FASE 9 — TESTS / QUALITY GATE (implementada, pendiente de revisión formal)

Fase 9 no agregó producto: convirtió el baseline de Fases 1–8 en un gate único, reproducible y offline.

- **Comando:** `npm run quality:gate` (raíz; delega a `backend/scripts/run-quality-gate.ts`). Exit 0 = pasa, ≠0 = falla. Modo AGGREGATE (todos los steps corren aunque uno falle). Sin credenciales, sin Firestore real, sin OpenRouter/ElevenLabs.
- **7 steps, en orden:** backend tests → backend build → backend scripts typecheck (`tsconfig.quality-gate.json`, excluye `*.test.ts`) → frontend tests → frontend build → config package validation de TODOS los paquetes (`config:validate-all`) → generic engine architecture scan (`architecture:scan`).
- **Nunca ejecuta:** `config:activate`, `config:import` (live), `sessions:mark-abandoned`, `sessions:mark-stale-evaluating`. La lista `STEPS` en `run-quality-gate.ts` es exhaustiva.
- **ENGINE_GENERICITY (6 reglas, regex + allowlist documentada, sin AST):** `CLIENT_LITERALS`, `NO_APP_USERS`, `NO_SHARED_TOKEN_IDENTITY`, `NO_LEXICOGRAPHIC_VERSION_PICK`, `NO_LITERAL_TENANT_BRANCH`, `NO_ORG_ID_LITERAL` (lista estática `sas-colombia`, `acme-demo`). Solo escanea `backend/src/` (nunca `config-packages/`). Cada regla tiene negative control sintético + `REGRESSION_GUARD` que falla si se agrega una regla sin snippet.
- **Negative controls:** config validation (loader inyectado que devuelve un paquete inválido), architecture scan (strings sintéticos), orchestrator (all-pass → 0, one-fail → 1, step que lanza → fallo reportado).
- **CI:** `.github/workflows/quality-gate.yml` (pull_request + push a master, sin secrets, sin deploy). No existía CI antes.
- **Ronda 1 de PASS_WITH_FIXES (cerrada):** P1 = faltaba detectar literales de org/cliente fuera de branches `===` (nueva regla `NO_ORG_ID_LITERAL`); P2 = el test de "cobertura de reglas" solo comparaba listas de ids (reemplazado por loop de negative controls reales).
- **Deuda de test explícita (no cerrada en Fase 9):** el cliente Firestore SDK nunca se mockea (repositorios probados solo vía fallback in-memory); el I/O de `main()` de scripts operativos sin testear; el typecheck del gate excluye `*.test.ts` por looseness de tipos preexistente en fixtures (~19 errores, ninguno bug de runtime); chunk de frontend de 741 kB.
- **Reporte:** `PHASE_09_TESTS_QUALITY_GATE_REPORT.md` (raíz), con el addendum de la ronda 1 en el mismo archivo. Plan de implementación: `docs/superpowers/plans/2026-09-23-fase9-quality-gate.md`.

## 6. BASELINE FINAL FASE 9

```
backend:  28 test files / 363 tests PASS
frontend:  2 test files /   8 tests PASS
backend build:  PASS (tsc -p tsconfig.json)
frontend build: PASS (tsc -b && vite build)
npm run quality:gate: PASS (7/7 steps, exit 0)
```

(Baseline previo, cierre de Fase 8: backend 24/335, frontend 2/8.)

Commits relevantes en `origin/master` (orden cronológico):

```
416d19c  Doc: addendum ronda 2 Fase 8 (trust proxy)                         ← cierre de Fase 8
7471b1b  Fase 9: config package validation gate (validate-all)
ec1929a  Fase 9: ENGINE_GENERICITY static rules (pure scan + negative controls)
43f57a6  Fase 9: scan real del filesystem + regression guard + CLI
b4a501e  Fase 9: orquestador puro con self-test (aggregate mode)
2185e78  Fase 9: wire npm run quality:gate (7 steps) + typecheck de scripts
07929d4  Fase 9: CI mínima (quality-gate.yml)
156c285  Doc: PHASE_09_TESTS_QUALITY_GATE_REPORT
3c4c270  Fase 9 PASS_WITH_FIXES ronda 1: P1 org-id literal + P2 negative controls   ← último fix
beb1138  Doc: addendum ronda 1 Fase 9                                        ← último addendum
```

Reportes: `PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT.md` y `PHASE_09_TESTS_QUALITY_GATE_REPORT.md` (raíz del repo, cada uno con sus addenda en el mismo archivo).

## 7. RATE LIMITING FINAL

Endpoints reales cubiertos (confirmados contra `routes.ts`, no asumidos):

| Endpoint | Costo | Scopes nuevos |
|---|---|---|
| `POST /session/start` | Alto (ElevenLabs signed-url) | user + organization + global |
| `POST /session/end` | Alto (OpenRouter, hasta 2 intentos × 30s) | user + organization + global |
| `POST /metrics/analyze` | Bajo (cómputo local) | user únicamente |
| `GET /health`, `GET /me`, `GET /admin/sessions` | Bajo | sin limiter dedicado — cubiertos por el IP safety cap |

Todas las keys tenant/user-aware vienen exclusivamente de contexto server-side resuelto (`req.auth.uid`, `req.appContext.organizationId`), nunca de `req.body`.

**IP safety cap:** default 300/min (`config.rateLimits.ipSafetyCap`, env `RATE_LIMIT_IP_SAFETY_CAP_PER_MIN`), pre-auth, capa de defensa adicional — nunca el mecanismo principal, deliberadamente por encima de todo límite de organización/usuario.

**Trust proxy = 1**, grounded en: `internet → Caddy → backend`. Caddy es el único servicio con puerto público (docker-compose `ports: 80/443`); el backend solo tiene `expose: "8080"`, inalcanzable directamente desde fuera de la red docker. Un cliente no puede falsificar su IP: con `trust proxy=1`, Express lee solo la entrada más a la derecha de `X-Forwarded-For` (la que Caddy mismo agrega), ignorando cualquier hop que el cliente anteponga.

## 8. CONFIG / CONTENT CONTRACT

```
FUENTES → HUMAN TEMPLATE → transformación controlada → config-package
→ validate → draft → QA → activate
```

`VOCERIA_CLIENT_CONTENT_TEMPLATE.zip` es el contrato humano. `backend/src/engine-config/schema.ts` es el contrato ejecutable (Zod). Si template y schema divergen: **se reporta, nunca se reconcilia silenciosamente**.

## 9. ROADMAP RESTANTE (no adelantar)

```
9  Tests / Quality Gate            ← IMPLEMENTADA, pendiente de revisión formal (ver 5b y 12)
10 Legacy Migration                ← SIGUIENTE tras cerrar la 9
11 Role Dashboard
12 Config Management
13 Novo Generic Onboarding Proof
14 Load / Concurrency
15 UX/UI Redesign — LAST
```

## 10. REVIEW FRAMEWORK

Usa este formato exacto para revisar cualquier entrega del agente ejecutor:

```
PHASE_REVIEW: PASS / PASS_WITH_FIXES / FAIL

WHAT_WAS_IMPLEMENTED:

WHAT_IS_CORRECT:

P0:
P1:
P2:
P3:

REGRESSIONS:

SECURITY_IMPACT:

MULTITENANT_IMPACT:

TECH_DEBT_INTRODUCED:

TEST_COVERAGE:

REQUIRED_FIXES:

OPTIONAL_IMPROVEMENTS:

FINAL_VERDICT:
```

Severidad: **P0** bloquea seguridad/tenant isolation/funcionamiento. **P1** debe resolverse antes de piloto multi-cliente. **P2** importante, no bloqueante. **P3** futuro. Una fase solo cierra cuando: comportamiento esperado correcto, tests relevantes pasan, no quedan P0/P1 de esa fase, no hay regresiones, multitenancy respetado, documentación actualizada.

## 11. POLÍTICAS OPERATIVAS

- No deploy salvo autorización explícita del usuario.
- No escribir en Firestore real sin autorización explícita (ver incidentes documentados en Fase 7/8: lecturas accidentales al verificar scripts localmente — evitar ejecutar cualquier script que llame `initFirebase()` directamente; verificar solo con tests que mockean `firebase.js`).
- No inventar contenido de clientes (nombres, rubrics, prompts) — todo viene de config real o de lo que el usuario provea.
- No implementar fases futuras adelantadas.
- Revisar commits reales y archivos reales — nunca confiar solo en el resumen del agente ejecutor.
- Preferir siempre la solución más pequeña, correcta, segura y escalable (`smallest correct secure scalable solution`) — no sobrearquitectar.
- UX/UI redesign va al final (Fase 15), no antes.

## 12. PRÓXIMO ESTADO

```
Fases 1–8: CLOSED / PASS
Fase 9:    IMPLEMENTADA + ronda 1 de PASS_WITH_FIXES corregida — PENDIENTE DE REVISIÓN FORMAL
NEXT:      revisar Fase 9; si cierra, Fase 10 — Legacy Migration (no empezarla sin instrucción explícita)
```

**Tu primera tarea:** revisar Fase 9 con el formato PHASE_REVIEW (sección 10), contra el código real y no contra el resumen:

1. `git clone` / `git pull`, luego `npm ci && npm run quality:gate` — debe dar 7/7 PASS, exit 0, en una máquina limpia sin credenciales.
2. Leer `PHASE_09_TESTS_QUALITY_GATE_REPORT.md` completo, incluido el addendum de la ronda 1.
3. Verificar que los negative controls realmente pueden fallar (por ejemplo, romper temporalmente un paquete o inyectar un literal prohibido en una copia local, confirmar que el gate falla, y revertir sin commitear).
4. Confirmar que Fase 9 no tocó código de runtime (rutas, auth/RBAC, lifecycle, evaluator, rate limits, trust proxy): `git diff 416d19c..HEAD --stat` debe mostrar solo tests/scripts/tooling/docs/CI.
5. Evaluar la deuda declarada (Firestore SDK sin mockear, I/O de scripts operativos sin testear, typecheck sin `*.test.ts`) y decidir si es aceptable para cerrar la fase o si algún punto sube a P1/P2.

No implementes ni commitees fixes por tu cuenta: si encuentras P0/P1, pídelos al agente ejecutor. No deploy, no Firestore real, no Fase 10.

---

## SKILLS SUGERIDAS PARA EL AGENTE EJECUTOR (Fase 10 en adelante)

Estas skills son relevantes si están disponibles en el entorno del ejecutor:
- **test-driven-development** — escribir cada test en rojo antes de implementar es el estándar que ya se siguió en Fases 7–9.
- **systematic-debugging** — para cualquier fallo de test no trivial que aparezca al endurecer el quality gate.
- **verification-before-completion** — nunca reportar tests/build en verde sin haber corrido el comando en esa misma sesión.
- **code-review** (o el flujo de revisión de este mismo chat) — para que el reviewer haga una segunda pasada sobre el diff real antes de dar PASS.
