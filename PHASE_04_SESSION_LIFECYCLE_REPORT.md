# PHASE_04_SESSION_LIFECYCLE_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 4 de 15 — Session Lifecycle Durable
**Fecha:** 22 de septiembre de 2026
**Commit base aprobado (Fase 3, cerrada):** `4c4072d39734b666352d03b52ac817c3bc8d1393`
**Código de esta fase:** `56055b547cc766e56af9df7cd051f64725548204`
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado.**

---

## WHAT_CHANGED

Se pasó de "una sesión persistida y con ownership durable" (Fase 3) a
"una sesión con un ciclo de vida explícito, donde `/session/end` es
idempotente, concurrency-safe, y ningún fallo queda oculto":

- Nuevo `SessionStatus`: `in_progress` → `evaluating` → `completed` /
  `evaluation_failed` / `persistence_failed`, más `abandoned`. Reemplaza
  el `"in_progress" | "completed" | "error"` anterior (`"error"` nunca se
  usaba realmente).
- `repositories/sessions.ts` centraliza **todas** las transiciones: nada
  en `routes.ts` escribe `status` directamente.
- `claimSessionForEvaluation`: una sola operación atómica (transacción de
  Firestore) que hace ownership + tenant check + la transición
  `in_progress|evaluation_failed|persistence_failed → evaluating`. Es el
  mecanismo de **concurrencia** (dos requests simultáneos, solo uno
  reclama) y de **idempotencia** (una sesión ya `completed` nunca se
  re-evalúa).
- `persistCompletedResult` reemplaza el `completeSession` fire-and-forget
  de Fase 3 — ahora **awaited**, y su fallo se distingue explícitamente
  (`markPersistenceFailed`) de un fallo de evaluación
  (`markEvaluationFailed`).
- `POST /session/end` reescrito sobre este flujo; la respuesta al cliente
  refleja únicamente lo que realmente quedó persistido, nunca un
  "éxito" optimista.
- `evaluatePitch` (OpenRouter) gana timeout explícito (30s) + un retry
  acotado (máximo 1 reintento, solo para 429/5xx/timeout, backoff de
  500ms). `getSignedUrl` (ElevenLabs) gana timeout explícito (10s), sin
  retry (cambio pequeño, como se autorizó).
- Nuevo helper manual `backend/scripts/mark-abandoned-sessions.ts` (no
  cron/scheduler) para la transición `in_progress → abandoned`.
- Taxonomía de errores consistente en las rutas de sesión: 400/401/403/
  404/409/502/503, sin filtrar mensajes internos al cliente (`/session/start`
  también se corrigió en este sentido).

No se tocó: el modelo Organization/Membership/Role (Fase 2-3), tenant
isolation ni RBAC (siguen exactamente igual — ver `MULTITENANT_IMPACT`),
ningún dashboard/UX/ENGINE-CONFIG/Novo, ni la migración de las ~68
sesiones legacy.

---

## SESSION_STATE_MODEL

```
in_progress         — conversación en curso; nadie la ha reclamado para evaluar
evaluating          — /session/end la reclamó; evaluación en curso (guarda concurrencia)
completed           — evaluación exitosa Y persistida de forma durable
evaluation_failed   — falló OpenRouter/el evaluador (timeout, 4xx/5xx, JSON inválido)
persistence_failed  — la evaluación tuvo éxito pero el guardado final en Firestore falló
abandoned           — in_progress demasiado tiempo, nunca llegó a /session/end
```

**Por qué estos 6 y no más:** separan exactamente las tres preguntas que
pedía el prompt — *"qué pasó con la conversación, qué pasó con la
evaluación, qué pasó con la persistencia"* — sin construir un estado por
cada combinación posible de causa de fallo (no hay
`evaluation_failed_timeout` vs `evaluation_failed_429`, por ejemplo; eso
vive en `failure_reason`, un string libre, no en el enum). `evaluating`
existe únicamente porque sin él no hay forma de implementar la guarda de
concurrencia (ver `CONCURRENCY_MODEL`) — es el estado más "técnico" de
los seis, pero es indispensable.

---

## VALID_TRANSITIONS

```
in_progress          → evaluating           (claimSessionForEvaluation)
in_progress           → abandoned            (markAbandoned, manual/helper)
evaluating            → completed            (persistCompletedResult)
evaluating            → evaluation_failed    (markEvaluationFailed)
evaluating            → persistence_failed   (markPersistenceFailed)
evaluation_failed     → evaluating           (claimSessionForEvaluation, retry)
persistence_failed    → evaluating           (claimSessionForEvaluation, retry)
```

**Explícitamente prohibidas (y verificadas por tests):**

```
completed  → evaluating     (idempotencia: se devuelve el resultado persistido, nunca se re-reclama)
evaluating → evaluating     (concurrencia: la segunda request ve in_progress_elsewhere, 409)
abandoned  → evaluating     (claimSessionForEvaluation devuelve wrong_state, 409)
abandoned  → completed      (sin operación de recuperación — no se construyó una en esta fase)
```

Todas las transiciones viven en `repositories/sessions.ts`
(`claimSessionForEvaluation`, `markEvaluationFailed`,
`markPersistenceFailed`, `persistCompletedResult`, `markAbandoned`) —
`routes.ts` nunca escribe un `status` directamente.

---

## SESSION_START_FLOW

Sin cambios de flujo respecto a Fase 3 (`requireAuth → requireMembership
→ crear sesión durable → recién entonces entregar signed_url`), con dos
ajustes de esta fase:

1. El estado inicial es explícitamente `"in_progress"` (ya lo era, ahora
   es un valor del enum `SessionStatus` en vez de un string suelto).
2. El manejo de errores se separó: un fallo de `getSignedUrl`
   (ElevenLabs, proveedor externo) responde **502**; un fallo de
   `createSession` (Firestore, dependencia interna) responde **503** —
   antes ambos caían en el mismo `catch` y devolvían 502 con el mensaje
   crudo del error. Ninguno de los dos expone ya el mensaje interno al
   cliente.

**Idempotencia de `/session/start`:** cada llamada crea un `session_id`
nuevo (`randomUUID()`) — no hay una clave de idempotencia externa que
dedupe "la misma solicitud de inicio". Esto es intencional y
proporcional: iniciar una sesión no tiene ningún efecto secundario
costoso o peligroso de duplicar (un signed URL de ElevenLabs no cuesta
nada hasta que se usa; dos sesiones creadas por un doble-click son dos
recursos legítimos e independientes, no un bug de datos). El prompt pidió
"idempotencia razonable, no un sistema distribuido complejo" — introducir
una clave de idempotencia (p. ej. un `Idempotency-Key` del cliente)
habría sido justamente esa complejidad innecesaria para un endpoint sin
efectos secundarios peligrosos que duplicar.

---

## SESSION_END_FLOW

```
1. requireAuth, requireMembership                (sin cambios, Fases 1-2)
2. Validar body: session_id, transcript           (400 si falta)
3. claimSessionForEvaluation(sessionId, ownerUid, organizationId)
   → not_found              → 404 (uniforme: no existe / no es tuya / no es de tu org)
   → wrong_state             → 409 (p. ej. abandoned)
   → in_progress_elsewhere   → 409 (otra request ya la está evaluando)
   → already_completed       → 200 con el resultado YA persistido (sin re-evaluar)
   → claimed                 → continúa
4. computeMetrics (determinístico, sin red)
5. evaluatePitch (OpenRouter, timeout + 1 retry acotado)
   → falla → markEvaluationFailed → 502
6. persistCompletedResult (Firestore, awaited)
   → falla → markPersistenceFailed → 503 (NUNCA 200)
7. 200 con { session_id, target_mode, metrics, evaluation }
```

La respuesta al cliente **siempre** refleja un estado real: o bien fue
persistido de verdad (paso 6 exitoso → 200), o bien hay un error
explícito y accionable (502/503/409/404). Nunca hay una ruta donde el
cliente reciba 200 sin que exista un documento `completed` real en
Firestore respaldándolo.

---

## IDEMPOTENCY_MODEL

**Caso pedido explícitamente:** cliente llama `/session/end`, el backend
procesa, la respuesta se pierde en la red, el cliente reintenta con el
mismo `session_id`.

- Si el primer intento ya llegó a `completed` antes de que la respuesta
  se perdiera: el reintento entra a `claimSessionForEvaluation`, ve
  `status: "completed"`, devuelve `already_completed` — `routes.ts`
  reconstruye la respuesta **desde el documento persistido**
  (`s.metrics`, `s.evaluation`), sin llamar a `evaluatePitch` de nuevo.
  Cero evaluaciones dobles, cero cobros dobles de OpenRouter.
- Si el primer intento seguía "evaluating" cuando el segundo llega: ve
  `in_progress_elsewhere` → 409. El cliente puede reintentar más tarde;
  cuando la primera evaluación termine (éxito o fallo), un reintento
  posterior verá `completed` (idempotente) o `evaluation_failed`/
  `persistence_failed` (reclamable, re-evalúa — ver abajo).
- Si el primer intento falló (`evaluation_failed`/`persistence_failed`)
  antes de que el cliente reintentara: el reintento SÍ dispara una nueva
  evaluación (`claimed`). Esto es intencional: no hay ningún resultado
  persistido que reutilizar — no hubo éxito que duplicar, solo un fallo
  que reintentar. Ver `RETRY_POLICY`.

No se usó Redis ni ningún locking externo — Firestore (transacción +
precondición implícita de lectura-antes-de-escritura dentro de
`runTransaction`) es la única fuente de coordinación, tal como pidió el
prompt.

---

## CONCURRENCY_MODEL

Dos requests `/session/end` concurrentes para el mismo `session_id`:
ambos llaman `claimSessionForEvaluation`, que ejecuta
`admin.firestore().runTransaction(...)`. Dentro de la transacción:

1. Lee el documento.
2. Si es reclamable (`in_progress`/`evaluation_failed`/
   `persistence_failed`), escribe `status: "evaluating"`.

Firestore garantiza que si dos transacciones leen el mismo documento y
ambas intentan escribir basadas en esa lectura, **solo una hace commit**;
la otra se reintenta automáticamente (el SDK vuelve a ejecutar el
callback de la transacción), y en ese reintento vuelve a leer —
encontrando ya `status: "evaluating"` — y toma la rama
`in_progress_elsewhere` en vez de reclamar de nuevo. Esto es lo que
garantiza "solo una evaluación real": no es un lock en memoria (que no
serviría entre instancias ni sobreviviría un restart), es la garantía
transaccional nativa de Firestore.

**Test que lo prueba de punta a punta** (`routes.test.ts`): dos llamadas
HTTP concurrentes a `/session/end` con el mismo `session_id` — se
verifica `evaluatePitchMock` llamado exactamente una vez, y las dos
respuestas son `[200, 409]` (en cualquier orden; cuál "gana" la carrera
no es determinista, y el test no lo asume).

---

## EVALUATION_FAILURE_MODEL

Cualquier fallo de `evaluatePitch` (timeout, 429, 5xx, contenido vacío,
JSON no parseable) se captura en `routes.ts`, se llama
`markEvaluationFailed(sessionId, reason)` (transición `evaluating →
evaluation_failed`, con `failure_reason` saneado — ver abajo), y se
responde **502** al cliente con un mensaje genérico y accionable ("No se
pudo evaluar la sesión. Intenta de nuevo más tarde."). La sesión **nunca**
queda silenciosamente en `evaluating` ni vuelve a `in_progress`.

Si incluso el propio `markEvaluationFailed` fallara (Firestore caído en
ese instante), se loguea internamente y la sesión queda atascada en
`evaluating` — ver `KNOWN_LIMITATIONS`, es el mismo tipo de estado
recuperable-pero-atascado que una sesión `abandoned` sin barrer.

`failure_reason` se trunca a 300 caracteres y nunca incluye un stack
trace — solo el mensaje de error ya resumido que arma `evaluator.ts`.

---

## PERSISTENCE_FAILURE_MODEL

`persistCompletedResult` es **una sola escritura** de Firestore
(`transcript` + `metrics` + `evaluation` + `status: "completed"` juntos,
vía un único `set()`) — un documento en Firestore se escribe de forma
atómica, así que no existe un estado intermedio donde el resultado esté
"parcialmente" guardado. O la escritura completa tiene éxito (→
`completed` con todo el resultado adentro), o falla por completo (→ nada
cambió).

Si falla: se captura en `routes.ts`, se intenta
`markPersistenceFailed(sessionId, reason)` — una escritura **más chica**
(solo `status` + `failure_reason`, sin el payload completo), con mejor
chance de éxito si el fallo original fue de tamaño de payload o un blip
transitorio. Si **esa** escritura también falla, la sesión queda en
`evaluating` (mismo caso límite que arriba). En cualquier caso, la
respuesta al cliente es **503**, nunca 200 — la evaluación sí se calculó,
pero como no hay nada persistido que la respalde, no se le puede decir al
cliente que "terminó".

**Costo aceptado documentado:** si el cliente reintenta tras un
`persistence_failed`, `claimSessionForEvaluation` lo permite (es un
estado reclamable) y **se vuelve a llamar a OpenRouter** — no hay forma
de reutilizar la evaluación que se perdió, porque nunca se persistió en
ningún lado. Es un trade-off consciente: la alternativa (persistir la
evaluación en algún lugar intermedio antes de saber si el documento final
se pudo escribir) habría sido la complejidad adicional que el prompt
pidió evitar, para un caso de fallo que se espera raro (escribir un
documento justo después de haberlo leído con éxito en la misma
transacción).

---

## RETRY_POLICY

**OpenRouter (`evaluator.ts`), el foco pedido:** máximo **1 reintento**
automático (2 intentos totales), backoff fijo de 500ms, **solo** para
errores transitorios: timeout, HTTP 429, HTTP 5xx. **Nunca** para un 4xx
distinto de 429 (una request mal formada no se arregla reintentando) ni
para un fallo de parseo de JSON (reintentar no cambia cómo el modelo
formatea su respuesta). Implementado como una clase interna
`EvaluationError { transient: boolean }` que separa la decisión de "vale
la pena reintentar" de la lógica de la petición HTTP en sí.

**ElevenLabs (`elevenlabs.ts`):** sin retry automático — cambio deliberado
y mínimo (solo timeout, ver `TIMEOUT_POLICY`). Un fallo aquí ya se
traduce en un 502 limpio desde `/session/start`, y reintentar la llamada
completa a `/session/start` es seguro y barato (ver
`SESSION_START_FLOW` § idempotencia) — no hacía falta una política de
retry separada dentro del servicio.

**`/session/end` en su conjunto:** no hay retry automático *dentro* de un
mismo request — el "retry" a nivel de sesión es el cliente volviendo a
llamar `/session/end` con el mismo `session_id`, lo cual el modelo de
estados ya maneja correctamente (idempotente si `completed`, reclamable
si `evaluation_failed`/`persistence_failed`, rechazado con 409 si
`evaluating`). Es la opción que el prompt marcó como igualmente válida:
"si decides no hacer retry automático todavía, también es válido si el
estado queda recuperable" — el estado queda recuperable por diseño.

---

## TIMEOUT_POLICY

| Llamada | Timeout | Mecanismo |
|---|---|---|
| OpenRouter (`evaluatePitch`) | 30s por intento (hasta 2 intentos = ~30.5s en el peor caso) | `AbortController` + `setTimeout` |
| ElevenLabs (`getSignedUrl`) | 10s | `AbortController` + `setTimeout` |

Ninguna de las dos llamadas puede quedar colgada indefinidamente. 30s se
eligió porque una evaluación real (transcript completo + rúbrica +
Claude Sonnet) puede tardar varios segundos de forma legítima; 10s para
ElevenLabs porque un signed URL es una respuesta pequeña y debería ser
casi instantánea — un timeout mucho más corto ahí.

---

## ABANDONED_POLICY

**Regla:** una sesión `in_progress` cuyo `started_at` sea más antiguo que
un umbral (default **6 horas**, configurable por flag) es candidata a
`abandoned`. El razonamiento del umbral: una práctica real dura minutos,
no horas — si sigue `in_progress` después de 6h, casi seguro el navegador
se cerró, la pestaña crasheó, o el usuario nunca llegó a
`/session/end`.

**No se construyó ningún cron/scheduler.** Tal como el prompt permitió
explícitamente, la implementación es un script manual:
`backend/scripts/mark-abandoned-sessions.ts`
(`npm run sessions:mark-abandoned --workspace=backend -- [--hours=N]
[--dry-run]`). Lista candidatas con
`listInProgressSessionsOlderThan(cutoff)` (una sola query de igualdad,
`status == "in_progress"`, sin índice compuesto) y llama `markAbandoned`
por cada una — que usa el **mismo mecanismo transaccional** que
`claimSessionForEvaluation`, así que si una sesión candidata es reclamada
por un `/session/end` real entre el listado y el intento de marcarla, la
transacción lo detecta (ya no está `in_progress`) y el script la salta en
vez de pisar una evaluación legítima en curso.

Correrlo con `--dry-run` primero es la forma recomendada de operarlo; sin
ese flag, escribe de verdad. Idempotente — correrlo dos veces no hace
nada distinto la segunda vez (las ya abandonadas no vuelven a aparecer
como `in_progress`).

---

## LEGACY_SESSION_POLICY

Sin cambios respecto a Fase 3: las ~68 sesiones anteriores a Fase 2/3 (sin
`organization_id`) **siguen fuera del lifecycle nuevo por completo**. No
se les asignó ningún estado del nuevo enum, no se tocaron, y
`parseSessionRecord` las sigue tratando como inválidas/ausentes (ahora
también valida que `status` sea uno de los 6 valores del nuevo enum —
otro motivo más por el que un documento legacy con forma distinta no pasa
la validación). `listInProgressSessionsOlderThan` (el sweep de abandono)
tampoco las alcanza: filtra por `status == "in_progress"`, que esos
documentos no tienen en la forma nueva.

**No se propuso ninguna migración en esta fase** — corresponde a una fase
de migración posterior, con dry-run + backup + rollback, tal como pidió
el prompt. No se mezcló aquí.

---

## FIRESTORE_MODEL

Sin cambios de colección (sigue siendo `sessions/{session_id}`, igual que
Fase 3). Campos nuevos en el documento:

```jsonc
{
  // ... campos de Fase 1-3 sin cambios (session_id, user_id, user_name,
  //     organization_id, owner_uid, target_mode, voice_gender, voice_id,
  //     started_at) ...
  "status": "in_progress | evaluating | completed | evaluation_failed | persistence_failed | abandoned",
  "updated_at": "server timestamp, se actualiza en CADA transición",
  "failure_reason": "string corto y saneado — solo presente en evaluation_failed / persistence_failed",
  "ended_at": "ISO — solo presente en completed",
  "duration_seconds": "solo presente en completed",
  "transcript": { "full": "...", "user_only": "...", "agent_only": "..." },  // solo en completed
  "metrics": { /* SpeechMetrics */ },   // solo en completed
  "evaluation": { /* EvaluationResult */ }  // solo en completed
}
```

Ninguna query nueva de esta fase necesita un índice compuesto:

| Método | Query | Índice |
|---|---|---|
| `claimSessionForEvaluation` / `getSessionById` | `get()` directo por id (dentro de una transacción) | No aplica |
| `markEvaluationFailed` / `markPersistenceFailed` / `persistCompletedResult` / `markAbandoned` | `set(..., {merge:true})` por id | No aplica |
| `listInProgressSessionsOlderThan` | `where('status','==','in_progress')` | **No** — una sola igualdad |

(Las queries de Fase 3, `listSessionsByOrganization` y
`listSessionsByOrganizationAndUser`, no cambiaron.)

---

## FILES_CHANGED

**Modificado**
- `backend/src/types.ts` — `SessionStatus`, campos nuevos en
  `SessionRecord` (`failure_reason`, `updated_at`, `transcript`,
  `metrics`, `evaluation`).
- `backend/src/repositories/sessions.ts` — reescrito: `createSession`
  (sin cambios de contrato, ahora también fija `updated_at`),
  `claimSessionForEvaluation`, `markEvaluationFailed`,
  `markPersistenceFailed`, `persistCompletedResult` (reemplaza
  `completeSession`), `markAbandoned`,
  `listInProgressSessionsOlderThan` (nuevos). `getSessionById` se
  mantiene como lectura general (ya no la usa `/session/end`
  directamente, pero sigue siendo parte pública del repositorio).
- `backend/src/routes.ts` — `/session/start` separa error de proveedor
  (502) vs. de persistencia (503), sin exponer mensajes internos;
  `/session/end` reescrito sobre `claimSessionForEvaluation` +
  `markEvaluationFailed`/`markPersistenceFailed`/`persistCompletedResult`.
- `backend/src/services/evaluator.ts` — timeout (30s) + retry acotado
  (máx. 1, solo transitorios) alrededor de la llamada a OpenRouter.
- `backend/src/services/elevenlabs.ts` — timeout (10s) en `getSignedUrl`.
- `backend/package.json` — script `sessions:mark-abandoned`.

**Nuevo**
- `backend/scripts/mark-abandoned-sessions.ts` — helper manual, no cron.
- `backend/src/repositories/sessions.test.ts` — 18 tests.
- `backend/src/services/evaluator.test.ts` — 7 tests.
- `PHASE_04_SESSION_LIFECYCLE_REPORT.md` — este documento.

---

## TESTS_ADDED

**`repositories/sessions.test.ts` (18, unitario, fallback en memoria —
misma lógica de decisión que corre contra Firestore en producción):**
round-trip `createSession`/`getSessionById`; `claimSessionForEvaluation`
— claim exitoso, `not_found` (desconocida / uid ajeno / org ajena),
`in_progress_elsewhere` (concurrencia), `already_completed` con
resultado real, `wrong_state` sobre `abandoned`, re-claim desde
`evaluation_failed` y desde `persistence_failed`; `markEvaluationFailed`
(incluye truncado de `failure_reason`); `markPersistenceFailed`;
`persistCompletedResult` (transcript+metrics+evaluation persistidos
juntos); `markAbandoned` (éxito, rechazo si `evaluating`, rechazo si
`completed`, `not_found`).

**`services/evaluator.test.ts` (7, unitario, `fetch` mockeado):** 200
limpio; retry en 503 transitorio (éxito al segundo intento); retry en
429; se agota tras el máximo de reintentos (2 intentos totales, no más);
**no** reintenta un 400; **no** reintenta un fallo de parseo JSON; timeout
dispara el mismo camino de retry (con fake timers).

**`routes.test.ts` → `describe("Phase 4: session lifecycle")` (8,
integración, repositorio mockeado con un fake in-memory propio para
controlar cada desenlace):** estado inicial correcto en
`/session/start`; `/session/end` in_progress→evaluating→completed con
transcript+metrics+evaluation persistidos; dos `/session/end`
concurrentes → una sola evaluación real (`evaluatePitchMock` llamado 1
vez, respuestas `[200,409]`); `/session/end` repetido tras `completed` →
no re-evalúa, devuelve el mismo resultado; fallo de evaluador →
`evaluation_failed`, 502; fallo de persistencia → nunca reporta
`completed`, 503; transición inválida (reclamar una `abandoned`) → 409;
fallo de Firestore durante el claim → 503 (falla cerrado).

Todos los tests de Fases 1–3 (auth, membership, roles, RBAC, tenant
isolation, ownership) se mantienen **verdes sin modificación de
expectativas** — solo se actualizó el mock de `repositories/sessions.js`
para exponer las nuevas funciones en vez de las viejas.

---

## TEST_RESULTS

```
$ npm test
> npm run test --workspace=backend && npm run test --workspace=frontend

backend:  Test Files  9 passed (9) | Tests  109 passed (109)
frontend: Test Files  1 passed (1) | Tests   4 passed (4)
```

(109 backend = 76 de Fases 1–3 + 33 nuevas de Fase 4: 18 en
`sessions.test.ts` + 7 en `evaluator.test.ts` + 8 en `routes.test.ts`.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores
          (mismo warning preexistente de tamaño de chunk, no relacionado)
```

---

## KNOWN_LIMITATIONS

- **Una sesión puede quedar atascada en `evaluating`** si tanto la
  operación original (evaluar o persistir) como el intento de marcar el
  fallo correspondiente (`markEvaluationFailed`/`markPersistenceFailed`)
  fallan — el caso de "Firestore está completamente caído en el momento
  exacto". Es el mismo tipo de estado recuperable-pero-atascado que una
  sesión sin `/session/end` nunca llamado; el sweep de abandono
  (`ABANDONED_POLICY`) eventualmente también recogería estas si se
  extendiera a incluir `evaluating` además de `in_progress` — no se hizo
  en esta fase porque el prompt pidió mantener el modelo pequeño.
- **`markAbandoned` no está expuesto por HTTP ni corre automáticamente.**
  Requiere ejecutarlo manualmente (o configurarlo en un cron externo al
  código de esta fase, p. ej. crontab del VPS) — deliberado, ver
  `ABANDONED_POLICY`.
- **Un reintento tras `persistence_failed` vuelve a llamar a OpenRouter**
  (costo real, ver `PERSISTENCE_FAILURE_MODEL`) — aceptado como
  trade-off, no oculto.
- **El umbral de abandono (6h) es un valor fijo**, no configurable por
  organización ni ajustado por escenario. Suficiente para un producto de
  un solo tipo de sesión (minutos de duración esperada).
- **No hay ningún endpoint para que un cliente consulte el estado de una
  sesión sin terminarla** (p. ej. "¿mi sesión anterior quedó
  `evaluation_failed`?") — solo `/session/end` expone estado, y solo
  para la sesión que uno mismo intenta terminar.
- **Las pruebas de concurrencia usan un delay artificial** en el mock del
  evaluador (`routes.test.ts`) para crear una ventana de carrera real —
  sin él, el evaluador mockeado resuelve tan rápido que una request
  puede terminar por completo antes de que la otra siquiera llegue a
  reclamar, lo cual no ejercitaría el camino `in_progress_elsewhere` en
  absoluto. Documentado en el propio test, no es un indicio de que el
  código de producción necesite ese delay — al contrario, es prueba de
  que la ventana de carrera real es corta.

---

## SECURITY_IMPACT

- **Tenant isolation y ownership de Fase 3 permanecen intactos, sin
  reimplementarse.** `claimSessionForEvaluation` sigue exigiendo
  `owner_uid === req.auth.uid` **y** `organization_id ===
  req.appContext.organizationId`, exactamente la regla que cerró el
  `PASS_WITH_FIXES` de Fase 3 — ahora vive dentro de la transacción en
  vez de un `if` suelto, pero la condición no cambió.
- **El 404 uniforme se mantiene y se extiende.** `not_found` sigue
  cubriendo "no existe", "no es tuya" y "no es de tu organización
  autorizada" con la misma respuesta — ahora además una sesión
  `abandoned` (que si existe y es tuya) da 409, no 404, porque en ese
  caso no hay nada que ocultar sobre su existencia (el caller ya demostró
  ownership al pasar el check dentro de la transacción antes de llegar a
  la rama `wrong_state`).
- **Ningún mensaje de error interno se filtra al cliente** en ninguna de
  las rutas tocadas en esta fase (`/session/start`, `/session/end`) —
  incluye una corrección a `/session/start`, que antes devolvía
  `(err as Error).message` crudo.

---

## MULTITENANT_IMPACT

Ninguno de los cambios de esta fase toca el modelo de Organization/
Membership/Role. `requireAuth`/`requireMembership`/`requireAnyRole` no se
modificaron. El único punto de contacto es que `claimSessionForEvaluation`
ahora recibe `organizationId` como parámetro explícito (en vez de que
`routes.ts` comparara `stored.organization_id` después de un `get()`
suelto) — el dato viene exactamente de la misma fuente que antes
(`req.appContext.organizationId`, resuelto por `requireMembership`), solo
que la comparación ahora ocurre dentro de la transacción en vez de antes
de ella.

---

## MIGRATION_NOTES

- **Nada de esto está desplegado.** Producción sigue en el código de
  Fase 0. No hace falta ninguna migración de datos para desplegar esta
  fase: las sesiones nuevas usan el modelo nuevo desde el primer
  `/session/start` posterior al deploy; las sesiones legacy (incluidas
  las creadas en Fases 1-3 durante pruebas locales, si las hubiera en el
  Firestore de producción) simplemente quedan fuera del lifecycle nuevo
  si no tienen los campos requeridos — mismo comportamiento que ya regía
  para las sesiones legacy de antes de Fase 2.
- **Frontend: cero cambios necesarios.** `frontend/src/api.ts` ya maneja
  cualquier respuesta no-2xx de forma genérica (lee `error` del body,
  lanza, `App.tsx` lo muestra en la pantalla de error con botón de
  reintento) — los nuevos códigos 409/502/503 de `/session/end` caen en
  ese mismo camino sin necesitar lógica nueva. Verificado leyendo
  `frontend/src/api.ts` y `frontend/src/App.tsx`, no se modificó ningún
  archivo del frontend en esta fase.
- **Operacional, no bloqueante para el deploy:** decidir si/cuándo correr
  `sessions:mark-abandoned` (manual o vía cron del VPS) es una decisión
  posterior a este reporte, no un prerequisito.

---

## OPEN_ITEMS

- [ ] Revisar y aprobar este reporte.
- [ ] Decidir si `sessions:mark-abandoned` se agenda en un cron real del
      VPS, o se sigue corriendo a mano.
- [ ] Considerar si el sweep de abandono debería también recoger
      sesiones atascadas en `evaluating` (ver `KNOWN_LIMITATIONS`).
- [ ] Fase de migración (posterior, fuera de esta fase): decidir qué
      hacer con las ~68 sesiones legacy — dry-run + backup + rollback.
- [ ] Fase 5+ (ENGINE vs CONFIG) puede eventualmente necesitar que
      `evaluatePitch`/`getSignedUrl` acepten configuración de
      timeout/retry por cliente — hoy son constantes fijas en código.
- [ ] Ningún endpoint expone el estado de una sesión sin terminarla —
      evaluar si hace falta antes de un dashboard real (Fase 11+).

---

**Commit de código de esta fase:** `56055b547cc766e56af9df7cd051f64725548204`
**Este reporte:** commiteado por separado, después del código.
