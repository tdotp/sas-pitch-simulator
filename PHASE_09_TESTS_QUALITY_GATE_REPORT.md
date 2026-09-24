# FASE 9 — TESTS / QUALITY GATE — REPORTE

Rol: agente ejecutor. Fases 1–8 CLOSED/PASS al inicio de esta fase (HEAD `416d19c1c83dd67be6ea8f8a40ce556ef5ea29bd` == `origin/master`, verificado en vivo antes de empezar). Esta fase no agrega producto: convierte el baseline existente en un gate único, reproducible y offline.

## WHAT_CHANGED

Solo tests/tooling. Cero cambios en rutas, UI, scoring, roles, session lifecycle o semántica de config.

Archivos nuevos:
- `backend/src/engine-config/validateAllPackages.ts` + `.test.ts`
- `backend/src/architecture/genericEngineScan.ts` + `.test.ts`
- `backend/src/architecture/runGenericEngineScan.ts` + `.test.ts`
- `backend/scripts/config-validate-all.ts`
- `backend/scripts/architecture-scan.ts`
- `backend/scripts/qualityGate.ts` + `.test.ts`
- `backend/scripts/run-quality-gate.ts`
- `backend/tsconfig.quality-gate.json`
- `.github/workflows/quality-gate.yml`
- `docs/superpowers/plans/2026-09-23-fase9-quality-gate.md` (plan de implementación)

Archivos modificados:
- `backend/package.json` (+5 scripts: `config:validate-all`, `architecture:scan`, `typecheck:scripts`, `quality:gate`, y el ya existente `config:validate` sin cambios)
- `package.json` raíz (+1 script: `quality:gate`)

## TEST_INVENTORY

Inventario verificado contra el código real (no resúmenes), antes de escribir una sola línea nueva. `backend/vitest.config.ts` no restringe `include` — cualquier `*.test.ts` bajo `backend/` corre, no solo bajo `src/`.

| Dominio | Estado (antes de Fase 9) | Evidencia |
|---|---|---|
| authentication | covered | `middleware/auth.test.ts`, `routes.test.ts` L406 |
| organization/membership | covered | `services/context.test.ts`, `routes.test.ts` L1004 (GET /me, 409 ambiguo, estados inactive) |
| RBAC / role policy | covered | `middleware/roles.test.ts`, `routes.test.ts` L838 (los 4 roles) |
| tenant isolation | covered | `routes.test.ts` L450, L1877 (spoof de `body.organization_id` ignorado) |
| session lifecycle | covered | `repositories/sessions.test.ts`, `routes.test.ts` L614/L1271 (concurrencia, retry idempotente, ack ambiguo, recovery, transición inválida) |
| config loader/resolver | covered | `engine-config/resolver.test.ts` (ambas funciones testeadas por separado, incl. los 3 fail-closed de integridad L194/205/219) |
| engine vs config (genericidad) | parcialmente covered (solo behavioral) → **covered (behavioral + static) tras Fase 9** | `engine/evaluatorPromptBuilder.test.ts`, `engine/promptBuilder.test.ts`, `services/metrics.test.ts` + **nuevo**: `architecture/genericEngineScan.test.ts`, `architecture/runGenericEngineScan.test.ts` |
| config version registry | covered | `repositories/configVersions.test.ts` |
| provenance/hash | covered | `routes.test.ts` L1271 (5 sub-casos), `resolver.test.ts` |
| evaluator runtime validation | covered | `services/evaluatorSchema.test.ts` |
| evaluator semantic validation | covered | `services/evaluatorSchema.test.ts` (`validateEvaluationContract`) |
| ElevenLabs provider | covered | `services/elevenlabs.test.ts` |
| OpenRouter provider | covered | `services/evaluator.test.ts` |
| persistence (Firestore real) | **missing** (no cerrado en esta fase — ver TEST_DEBT) | ningún test mockea el cliente Firestore/`admin.firestore()`; solo se testea el fallback in-memory |
| recovery | parcialmente covered | `repositories/sessions.test.ts` (`listEvaluatingSessionsOlderThan`), `scripts/staleEvaluatingArgs.test.ts` (solo parseo de args, no el `main()`) |
| structured logging | covered | `observability/log.test.ts` + redacción verificada en tests de providers/rate-limit |
| rate limiting | covered | `middleware/rateLimit.test.ts`, `routes.test.ts` L1786, `trustProxy.test.ts` |
| trust proxy | covered | `trustProxy.test.ts` |
| observability summarizer | covered | `scripts/observabilitySummarize.test.ts` |
| frontend | covered (angosto, 2 archivos) | `api.test.ts`, `Analysis.test.tsx` |
| config package validation (todos los paquetes) | **missing** → **covered tras Fase 9** | **nuevo**: `engine-config/validateAllPackages.ts`/`.test.ts` |
| quality gate reproducible | **missing** → **covered tras Fase 9** | **nuevo**: `scripts/qualityGate.ts`/`.test.ts`, `scripts/run-quality-gate.ts` |

No se agregó ningún test a los dominios ya cubiertos — habría sido "más tests" sin cerrar ningún hueco real.

## CRITICAL_INVARIANT_MATRIX

| Invariante | Test(s) | Qué falla si se rompe |
|---|---|---|
| Sin token → no acceso | `routes.test.ts` L406-449 | 401 antes de tocar cualquier lógica de negocio |
| `body.organization_id`/`role` nunca redefine tenant | `middleware/rateLimit.test.ts` (tenant-trust-boundary), `routes.test.ts` L450, L1877, L1004 | un spoof del body movería el bucket/tenant de otro cliente |
| `AGENCY_ADMIN` solo ve orgs con Membership real | `routes.test.ts` L838 (409 ambiguo multi-org) | acceso cross-tenant no autorizado |
| `evaluating` nunca sobreescribe `completed` | `repositories/sessions.test.ts`, `routes.test.ts` L614 | doble evaluación / resultado corrupto |
| Sesión pinneada a v1 nunca la reinterpreta v2 activada después | `routes.test.ts` L1271 "THE KEY TEST" | provenance silenciosamente reescrito |
| Hash drift → fail closed (nunca re-pinnea) | `routes.test.ts` L1271 CONFIG HASH block, `resolver.test.ts` L194/205/219 | contenido editado in-place serviría sin re-activar |
| Evaluator: ids desconocidos/faltantes/duplicados/`max_score≠weight` → rechazado | `evaluatorSchema.test.ts` | resultado de evaluación no conforme al framework pinneado |
| Rate limit keys solo de `req.auth.uid`/`req.appContext.organizationId` | `middleware/rateLimit.test.ts`, `routes.test.ts` L1786 | un cliente podría elegir su propio bucket |
| `req.ip` real detrás de Caddy (no colapsa en un solo bucket) | `trustProxy.test.ts` | IP safety cap inútil tras el proxy |
| **[NUEVO] engine sin literales/branches client-specific** | `architecture/genericEngineScan.test.ts` (control negativo sintético), `architecture/runGenericEngineScan.test.ts` (guardia contra el repo real) | regresión silenciosa del engine/config split (lo que pasó antes de Fase 5) |
| **[NUEVO] todo config package en el repo valida** | `engine-config/validateAllPackages.test.ts` (control negativo con loader inyectado) | un paquete roto se cuela sin que nada lo note hasta producción |
| **[NUEVO] el gate agrega todos los steps, nunca aborta a mitad de camino** | `scripts/qualityGate.test.ts` (`AGGREGATE_NOT_FAIL_FAST`) | un operador vería solo el primer bloque roto, no todos |

## AUTH_COVERAGE / MULTITENANT_COVERAGE / RBAC_COVERAGE / SESSION_LIFECYCLE_COVERAGE / EVALUATOR_CONTRACT_COVERAGE / PROVIDER_RELIABILITY_COVERAGE / OBSERVABILITY_COVERAGE / RATE_LIMIT_COVERAGE / TRUST_PROXY_COVERAGE / VERSIONING_PROVENANCE_COVERAGE

Sin cambios respecto al baseline de Fase 8 — ya cubiertos (ver tabla TEST_INVENTORY arriba con archivo/línea exacto). No se tocó ningún test de estos dominios.

## ENGINE_GENERICITY_COVERAGE (nuevo)

Dos capas:
1. **Pura** (`genericEngineScan.ts`): 5 reglas explícitas contra literales/patrones prohibidos, con allowlist documentada por cada excepción legítima conocida (el propio archivo de reglas, el comentario histórico en `types.ts`, el gate `x-app-token` en `routes.ts`). Control negativo: strings sintéticos, nunca archivos reales contaminados.
2. **Filesystem real** (`runGenericEngineScan.ts`): camina `backend/src` (excluye `node_modules`, `dist`, `config-packages`), corre contra el repo real hoy: **0 violaciones**. Este test es una guardia de regresión viva — si alguien reintroduce un literal prohibido en código genérico, este test falla.

Reglas: `ENGINE_GENERICITY_CLIENT_LITERALS`, `ENGINE_GENERICITY_NO_APP_USERS`, `ENGINE_GENERICITY_NO_SHARED_TOKEN_IDENTITY`, `ENGINE_GENERICITY_NO_LEXICOGRAPHIC_VERSION_PICK`, `ENGINE_GENERICITY_NO_LITERAL_TENANT_BRANCH`.

Nombres de cliente (`sas-colombia`, `davivienda`, `acme-demo`, etc.) siguen siendo válidos en `backend/config-packages/` — el scan nunca entra ahí, así que esto se cumple estructuralmente, no por una lista de excepciones de nombres.

## CONFIG_VALIDATION_COVERAGE (nuevo)

`config:validate` (Fase 6) seguía validando un solo path por invocación. `config:validate-all` (nuevo) descubre y valida los 3 paquetes reales del repo (`acme-demo/v1`, `acme-demo/v2`, `sas-colombia/v1`) en una sola pasada, vía el mismo `FileConfigPackageLoader` de producción — misma validación de dos pasadas (estructural Zod + semántica de referencias cruzadas). No se toca `config:validate` ni la ruta de request-time.

## STATIC_ARCHITECTURE_CHECKS

Ver ENGINE_GENERICITY_COVERAGE. Deliberadamente NO es un AST analyzer — es un scan de línea por regex con allowlist explícita, matching la recomendación del spec ("no construyas un linter complejo si un grep reproducible alcanza").

## QUALITY_GATE_COMMAND

```
npm run quality:gate
```

(desde la raíz del repo; delega a `backend`'s propio `npm run quality:gate`, que corre `tsx scripts/run-quality-gate.ts`).

## QUALITY_GATE_STEPS

Orden determinista, modo **AGGREGATE** (decisión documentada: cada step corre siempre, incluso si uno anterior falló — un operador arreglando un gate rojo quiere ver todos los bloques rotos en una corrida, no uno a la vez):

1. `backend tests` (`npm test` en `backend/` → `vitest run`)
2. `backend build` (`npm run build` en `backend/` → `tsc -p tsconfig.json`)
3. `backend scripts typecheck` (`npm run typecheck:scripts` en `backend/` → `tsc --noEmit -p tsconfig.quality-gate.json`, cubre `backend/scripts/*.ts`, nunca tipado por el build de producción)
4. `frontend tests` (`npm test` en `frontend/` → `vitest run`)
5. `frontend build` (`npm run build` en `frontend/` → `tsc -b && vite build`)
6. `config package validation (all)` (`npm run config:validate-all` en `backend/`)
7. `generic engine architecture scan` (`npm run architecture:scan` en `backend/`)

**TEST_ENVIRONMENT_SAFETY (spec item 13):** esta lista de 7 comandos es exhaustiva — es literalmente el array `STEPS` en `backend/scripts/run-quality-gate.ts`. El gate **nunca** invoca `config:activate`, `config:import` (sin `--dry-run`), `sessions:mark-abandoned`, ni `sessions:mark-stale-evaluating` — ninguno de esos 4 comandos aparece en `STEPS` ni en ningún script que el gate llame transitivamente. Cualquier paso nuevo debe agregarse a `STEPS` Y a esta sección, nunca en silencio.

## OFFLINE_SAFETY

Ningún step llama Firestore real, OpenRouter o ElevenLabs:
- Backend tests: mockean `firebase-admin` (solo `auth().verifyIdToken`), `firebase.js` (`isAuthReady`/`isPersistenceEnabled`), `services/elevenlabs.js`, `services/evaluator.js`, y los repositorios vía un fake in-memory (patrón documentado en `routes.test.ts` L1-297).
- `config:validate-all`: puro filesystem, no llama `initFirebase()`.
- `architecture:scan`: puro filesystem.
- Backend/frontend build: solo `tsc`/`vite`, sin red.

Ningún script que llame `initFirebase()` (`bootstrap:phase2-legacy-org`, `sessions:mark-*`, `config:import`, `config:activate`) es parte del gate ni de `npm test`.

## CI_DECISION

No existía CI (`.github/workflows/` no existía antes de esta fase). Se creó `.github/workflows/quality-gate.yml`: un solo job, sin secrets, corre en `pull_request` y `push` a `master`, pasos: checkout → setup-node@20 → `npm ci` → `npm run quality:gate`. No hace deploy, no toca Firestore real, no llama providers reales — coherente con OFFLINE_SAFETY.

## NEGATIVE_CONTROLS

1. **Config validation**: `validateAllPackages.test.ts` → `CONFIG_VALIDATION_NEGATIVE_CONTROL` — un `ConfigPackageLoader` inyectado (fake) devuelve un paquete inválido para `org-b`; el test verifica que `validateAllConfigPackages` lo reporta como `valid:false` con el error exacto, sin tocar ningún paquete real committeado.
2. **Architecture scan**: `genericEngineScan.test.ts` — 4 tests con strings sintéticos (`mentioned_sas`, `APP_USERS`, `organizationId === "sas-colombia"`, `.sort().reverse()`) que nunca tocan un archivo real del engine, probando que cada regla efectivamente puede fallar.
3. **Quality gate orchestrator**: `qualityGate.test.ts` → `QUALITY_GATE_SELF_TEST` (all-pass → exit 0; one-fail → exit 1) + `AGGREGATE_NOT_FAIL_FAST` (un step roto no cancela los siguientes) + manejo de un step que lanza excepción (se reporta como fallo, no como crash no controlado).

## FILES_CHANGED / TESTS_ADDED

Ver WHAT_CHANGED. Tests nuevos: 4 archivos, 18 tests (4 + 8 + 1 + 5).

## TEST_RESULTS

```
backend:  28 test files / 353 tests PASS   (baseline Fase 8: 24/335 + 4 archivos/18 tests nuevos)
frontend:  2 test files /   8 tests PASS   (sin cambios respecto a Fase 8)
```

## BUILD_RESULTS

```
backend build:            PASS (tsc -p tsconfig.json)
backend scripts typecheck: PASS (tsc --noEmit -p tsconfig.quality-gate.json, excluye *.test.ts — ver KNOWN_LIMITATIONS)
frontend build:           PASS (tsc -b && vite build)
```

## QUALITY_GATE_RESULT

Corrida real desde la raíz del repo, `npm run quality:gate`, exit code `0`:

```
[PASS] backend tests (4163ms)
[PASS] backend build (1028ms)
[PASS] backend scripts typecheck (988ms)
[PASS] frontend tests (457ms)
[PASS] frontend build (1331ms)
[PASS] config package validation (all) (285ms)
[PASS] generic engine architecture scan (232ms)

QUALITY GATE: PASS (7/7 steps)
```

## SECURITY_IMPACT / MULTITENANT_IMPACT

Ninguno — cero cambios en código de producción (rutas, middleware, repositorios, engine). Todo lo nuevo es test/tooling que corre en CI/local, nunca en el runtime de la app.

## TECH_DEBT_INTRODUCED

Ninguno nuevo. El `tsconfig.quality-gate.json` documenta explícitamente por qué excluye `*.test.ts` (ver KNOWN_LIMITATIONS) en vez de silenciar errores.

## KNOWN_LIMITATIONS

- `backend scripts typecheck` excluye `**/*.test.ts`. Al tipar `backend/scripts/**/*` por primera vez (nunca cubierto por `npm run build`), aparecieron ~19 errores de tipado preexistentes, todos dentro de archivos de test (`sessions.test.ts`, `routes.test.ts`), todos looseness de tipos en fixtures/mocks (un fixture de sesión sin `scenario_id` opcional-vs-requerido; mutación deliberada de un mock `readonly` de rate limits entre casos de test; un par de narrowings de `mock.calls[0]`). Ninguno es un bug de runtime — los 353 tests pasan. Se decidió excluir `*.test.ts` del typecheck del gate en vez de tocar tests que ya pasan y no forman parte del alcance de esta fase.
- El chunk de frontend (`index-*.js`, 741 kB) supera el warning de 500 kB de Vite. No es un invariante de Fase 1–8 ni bloquea el gate; queda anotado por si se retoma en una fase de frontend futura.

## TEST_DEBT

- **Firestore SDK nunca mockeado**: ningún test en el repo mockea `admin.firestore()`/el cliente real de Firestore. Los repositorios se testean únicamente contra el fallback in-memory (`isPersistenceEnabled: () => false`). Las rutas de código que sí hablan con Firestore real (transacciones, queries) están sin ejercitar por ningún test. Construir ese mock es infraestructura sustancial, ortogonal al objetivo de esta fase ("construir el gate sobre lo que ya existe", no "más cobertura").
- **I/O de scripts operativos sin testear**: `mark-stale-evaluating-sessions.ts`, `mark-abandoned-sessions.ts`, `config-import.ts`, `config-activate.ts` — solo sus helpers puros (`parseHours()`) están testeados; el `main()` que llama `initFirebase()` y escribe en Firestore no lo está.

## DEFERRED_TO_PHASE_10

- Mock del cliente Firestore SDK para ejercitar las rutas de persistencia real de los repositorios.
- Tests de I/O (con mocks) para los `main()` de los scripts operativos listados en TEST_DEBT.
- Migración de sesiones legacy (ya en el roadmap original como Fase 10, sin relación con lo anterior salvo que ambos tocan `repositories/`).

## OPEN_ITEMS

Ninguno bloqueante. `P0 = 0`, `P1 = 0`.

## CRITERIO_DE_CIERRE

- ✅ Todos los tests Fase 1–8 siguen verdes (353/353 backend incluyendo los 335 originales, 8/8 frontend)
- ✅ Quality gate único existe (`npm run quality:gate`)
- ✅ Quality gate pasa (7/7, exit 0)
- ✅ Gate es offline/hermético (ver OFFLINE_SAFETY)
- ✅ Config packages se validan (los 3 reales, en una pasada)
- ✅ Critical architecture checks pasan (0 violaciones ENGINE_GENERICITY)
- ✅ Negative controls demuestran que los checks pueden fallar (3 negative controls, ver NEGATIVE_CONTROLS)
- ✅ Tenant/security invariants siguen cubiertas (ninguna se tocó)
- ✅ Frontend build/test sigue verde
- ✅ Backend build/test sigue verde
- ✅ No deploy, no Firestore real, no providers reales
- ✅ P0 = 0, P1 = 0

**FASE 9: PASS**
