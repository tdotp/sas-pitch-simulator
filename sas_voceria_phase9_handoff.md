# SAS VOCERIA — CONTEXT HANDOFF / START PROMPT (post Fase 8)

## 1. ROL DEL NUEVO CHAT

Actúa como **arquitecto técnico, reviewer, QA y auditor** del proyecto SAS VOCERIA. Este chat comienza con las Fases 1–8 ya aprobadas y cerradas (Fase 8 con 3 rondas de PASS_WITH_FIXES, todas cerradas).

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

## 6. BASELINE FINAL FASE 8

```
backend:  24 test files / 335 tests PASS
frontend:  2 test files /   8 tests PASS
backend build:  PASS (tsc -p tsconfig.json)
frontend build: PASS (tsc -b && vite build)
```

Commits finales relevantes en `origin/master` (orden cronológico, todos pusheados y verificados con `git log --oneline origin/master`):

```
079eda8a8ac982d1fa93bdedb015cf1ff33c7bbc  Fase 8 PASS: observability + rate limits (código)
9d2072e73aa615ad3be209efce44f3e4f33bf5f9  Doc: PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT
0318eded1fcdbc9bf4c817b82ecf896a7014d698  Fase 8 PASS_WITH_FIXES ronda 1: limiter IP/p95/outcome (código)
9e5d962fb2e16f4caa64db10d0fb827c02868e8b  Doc: addendum ronda 1
0e9d25c224078e284951832a2c046207635d16a6  Fase 8 PASS_WITH_FIXES ronda 2: trust proxy (código)  ← último fix
416d19c1c83dd67be6ea8f8a40ce556ef5ea29bd  Doc: addendum ronda 2 (trust proxy)                    ← último addendum
```

Reporte completo: `PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT.md` (raíz del repo), con las 2 rondas de addendum incluidas en el mismo archivo.

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
9  Tests / Quality Gate            ← SIGUIENTE
10 Legacy Migration
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
NEXT: Fase 9 — Tests / Quality Gate
```

No diseñes ni implementes Fase 9 todavía en este mensaje de arranque — espera instrucción explícita para definir su alcance.

---

## SKILLS SUGERIDAS PARA EL AGENTE EJECUTOR (Fase 9 en adelante)

Cuando el ejecutor implemente Fase 9 ("Tests / Quality Gate"), estas skills son directamente relevantes si están disponibles en su entorno:
- **test-driven-development** — Fase 9 es literalmente sobre tests; escribir cada test en rojo antes de implementar es el estándar que ya se siguió en Fases 7–8.
- **systematic-debugging** — para cualquier fallo de test no trivial que aparezca al endurecer el quality gate.
- **verification-before-completion** — nunca reportar tests/build en verde sin haber corrido el comando en esa misma sesión.
- **code-review** (o el flujo de revisión de este mismo chat) — para que el reviewer haga una segunda pasada sobre el diff real antes de dar PASS.
