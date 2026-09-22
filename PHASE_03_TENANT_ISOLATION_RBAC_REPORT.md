# PHASE_03_TENANT_ISOLATION_RBAC_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 3 de 15 — Tenant Isolation + RBAC real
**Fecha:** 22 de septiembre de 2026
**Commit base aprobado (Fase 2, cerrada):** `5a34b26356630774ce616d8155e1eac14d503fe2`
**Código de esta fase:** `6ba4e12e472b4af10e35d05f570715593744fd61`
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado.**

---

## WHAT_CHANGED

Se pasó de "sabemos quién es el usuario + a qué organización pertenece +
su rol" (Fase 2) a que **el backend use esa información para decidir qué
puede leer o modificar**:

- Las sesiones nuevas quedan vinculadas a una organización
  (`organization_id`, tomado exclusivamente de `req.appContext`, nunca del
  cliente) y persistidas de forma **awaited** (no fire-and-forget) en
  `/session/start`, para que el chequeo de ownership de `/session/end`
  pueda leer estado realmente persistido en vez de un `Map` en memoria.
- `/session/end` verifica ownership (`starter uid === authenticated uid`)
  contra ese estado persistido, con un **404 uniforme** tanto para
  "sesión inexistente" como para "sesión de otra persona" (anti-
  enumeración).
- `/metrics/analyze` ahora exige `requireMembership` además de
  `requireAuth`.
- **`GET /admin/sessions` cierra el P0 abierto desde Fase 1**: ya no
  devuelve todas las sesiones a cualquiera. Ahora exige
  `requireAnyRole("AGENCY_ADMIN", "CLIENT_ADMIN", "COACH")` (SPOKESPERSON
  → 403) y solo devuelve sesiones de la organización resuelta en
  `req.appContext` — nunca "todas las organizaciones".
- Nuevo middleware reutilizable `requireAnyRole(...)`
  (`backend/src/middleware/roles.ts`) — la única lógica de rol en todo el
  backend, sin `if (role === ...)` repetidos en `routes.ts`.
- Nuevo repositorio `backend/src/repositories/sessions.ts`: reemplaza el
  `Map` en memoria de Fase 1 y los helpers genéricos que vivían en
  `firebase.ts` (`saveSessionStart`/`saveSessionResult`/`listSessions`)
  por métodos explícitos y tenant-aware: `createSession`,
  `getSessionById`, `completeSession`, `listSessionsByOrganization`,
  `listSessionsByOrganizationAndUser`.
- **`AUTH_ALLOWED_EMAILS` (allowlist de Fase 1) retirada.** Ver
  `ALLOWLIST_DECISION` abajo.

No se tocó: la arquitectura de voz (navegador ↔ ElevenLabs directo),
Firestore como storage, el contrato de `requireAuth`/`requireMembership`/
`req.appContext` aprobado en Fases 1–2 (se reutiliza tal cual, no hay una
segunda fuente de verdad), ni ningún dashboard/rediseño/ENGINE-CONFIG/
Novo — todo eso sigue fuera de alcance.

---

## AUTHORIZATION_MODEL

```
requireAuth            (Fase 1: Firebase ID token verificado -> req.auth)
    ↓
requireMembership       (Fase 2: Membership activa -> req.appContext)
    ↓
requireAnyRole(...)      (Fase 3, nuevo: filtra por rol cuando aplica)
    ↓
handler de la ruta       (ownership/tenant scoping específico del recurso)
```

Cada capa es independiente y reutilizable — `requireAnyRole` no reimplementa
nada de las capas anteriores, solo lee `req.appContext.role` (ya resuelto,
ya verificado contra Firestore, nunca contra el cliente).

**Ningún handler confía en el cliente para autoridad.** El body/query puede
llevar `organization_id`, `session_id`, `role`, etc. — todos se usan como
máximo como una **selección** (p. ej. `?organization_id` en `/me` y
`/admin/sessions`, verificado contra las memberships reales del uid) o se
ignoran directamente (`role`, `organization_id` en `/session/start`,
`user_id`/`user_name`). El único campo del body que sigue siendo
"autoridad del cliente" en el sentido normal es contenido de negocio no
sensible a tenant: `transcript`, `duration_seconds`, `target_mode` (qué
escenario practicar) — nada de eso decide organización, rol ni ownership.

---

## ROLE_POLICY

Política V1 (la pedida explícitamente, sin permisos granulares ni ACLs):

| Rol | Puede |
|---|---|
| `AGENCY_ADMIN` | Acceso administrativo (`/admin/sessions`) dentro de las organizaciones donde tiene Membership activa. Cross-org solo si tiene Membership real en cada una — nunca "todas". |
| `CLIENT_ADMIN` | Acceso administrativo dentro de su organización. |
| `COACH` | Lectura de sesiones/resultados de su organización. **V1: sin filtrar por assignment** (ve toda la organización, no solo trainees asignados) — documentado como política V1, no un bug. |
| `SPOKESPERSON` | Entrenar (`/session/start`, `/session/end` de sus propias sesiones) y consultar resultados propios (la respuesta de `/session/end`). **Sin acceso a `/admin/sessions`** — `requireAnyRole` lo rechaza con 403. |

Implementado en un solo lugar: `requireAnyRole("AGENCY_ADMIN",
"CLIENT_ADMIN", "COACH")` en la definición de `GET /admin/sessions`
(`routes.ts`). Ninguna otra ruta tiene restricción de rol — `/session/start`,
`/session/end` y `/metrics/analyze` son accesibles para cualquier rol con
Membership válida (todos, incluido `SPOKESPERSON`, deben poder practicar).

No implementado (fuera de alcance explícito de esta fase): assignments
coach→trainee, permisos granulares, ACLs custom.

---

## TENANT_ISOLATION_MODEL

La organización de cada request viene **exclusivamente** de
`req.appContext.organizationId`, resuelto por `requireMembership` (Fase 2,
sin cambios en esta fase) contra Firestore. Dos formas en que eso se
concreta en Fase 3:

1. **Escritura (`/session/start`):** `organization_id` de la sesión nueva
   = `req.appContext.organizationId`. El body puede mandar cualquier cosa
   en `organization_id` — nunca se lee para esto.
2. **Lectura (`GET /admin/sessions`):** la query a Firestore está
   filtrada por `organization_id == req.appContext.organizationId` — no
   existe ningún modo de pedir "todas las organizaciones" en el código;
   ni siquiera `AGENCY_ADMIN` puede evitarlo (ver `AGENCY_ADMIN_BOUNDARY`).

Selección explícita de organización (para roles/usuarios con más de una
Membership elegible) reutiliza el contrato ya aprobado en Fase 2:
`?organization_id=X` en la query string, verificado contra las memberships
reales del uid autenticado antes de usarse — nunca confiado a ciegas. Se
aplicó tal cual a `GET /admin/sessions` (mismo mecanismo que ya tenía
`GET /me`).

---

## SESSION_OWNERSHIP

Regla implementada, la más simple posible según lo pedido: **el uid que
inició la sesión (`owner_uid`) debe ser igual al uid autenticado que la
termina.** Sin excepción por rol — `CLIENT_ADMIN`/`COACH`/`AGENCY_ADMIN`
NO tienen ningún bypass en `/session/end`. La razón es explícita: acceso
administrativo a *resultados* es un problema de **lectura**
(`GET /admin/sessions`), no algo que deba permitir que un admin
mute/complete la sesión de otra persona con solo conocer su id.

```ts
if (!stored || stored.owner_uid !== req.auth!.uid) {
  return res.status(404).json({ error: "Sesión no encontrada" });
}
```

**Decisión de status code:** 404 uniforme, no 403, y **el mismo 404** para
"la sesión no existe" y "la sesión existe pero es de otra persona" —
deliberado, para que un caller no pueda usar la diferencia de respuesta
para enumerar qué `session_id` son reales aunque no le pertenezcan. Ver
`SECURITY_NOTES`.

**Basado en estado persistido, no en el `Map`:** `getSessionById` lee del
repositorio de sesiones (`repositories/sessions.ts`), que en modo
persistencia activa (el caso normal) lee Firestore directamente — no hay
ningún `Map` de por medio en el camino de `/session/end`. Esto cierra,
específicamente para el ownership check, el `KNOWN_LIMITATION` que Fase 1
dejó abierto ("no durable, se pierde al reiniciar") **sin** construir el
resto del session lifecycle (estados de abandono, migración histórica,
etc. — eso sigue siendo Fase 4).

---

## SESSION_SCHEMA_CHANGES

`SessionRecord` (`backend/src/types.ts`) gana:

```ts
organization_id?: string; // de req.appContext, nunca del cliente
```

(`owner_uid?: string` ya existía desde Fase 1 — su semántica no cambió,
solo dónde y cómo se lee: antes solo del `Map`, ahora del repositorio de
sesiones.)

`organization_id` queda **opcional en el tipo** únicamente para reflejar
la realidad de Firestore (las ~68 sesiones legacy no lo tienen) — toda
sesión creada desde `POST /session/start` en Fase 3 en adelante SIEMPRE
lo trae, sin excepción (`routes.ts` lo asigna directo desde
`req.appContext.organizationId`, no hay ninguna rama que lo omita).

---

## ADMIN_SESSION_POLICY

`GET /admin/sessions`:

1. `requireAuth` → 401 si no hay token válido.
2. `requireMembership` → 403 si no hay Membership elegible; 409 si hay 2+
   sin `?organization_id`; 403 si el `?organization_id` pedido no es una
   membership real del uid. (Mismo contrato que `GET /me`, sin
   reimplementarlo.)
3. `requireAnyRole("AGENCY_ADMIN", "CLIENT_ADMIN", "COACH")` → 403 para
   `SPOKESPERSON` (o cualquier rol futuro no listado aquí).
4. El handler llama `listSessionsByOrganization(req.appContext.organizationId)`
   — **una única organización, siempre la resuelta por `requireMembership`**
   — y devuelve `{ organization_id, sessions }`.

No hay ninguna forma de pedir sesiones de más de una organización en una
sola llamada, ni para `AGENCY_ADMIN`. Un `AGENCY_ADMIN` con Membership en
A y B hace dos llamadas (`?organization_id=A`, luego `?organization_id=B`)
— comportamiento explícito, no un descuido (ver `AGENCY_ADMIN_BOUNDARY`).

---

## AGENCY_ADMIN_BOUNDARY

`AGENCY_ADMIN` **no es superusuario global.** No existe en el código
ningún camino que le dé acceso a una organización donde no tenga
Membership activa — el mismo `requireMembership` que se aplica a
`CLIENT_ADMIN`/`COACH`/`SPOKESPERSON` se aplica a `AGENCY_ADMIN` sin
ninguna rama especial. Probado explícitamente
(`routes.test.ts`): un `AGENCY_ADMIN` con Membership en `org-a` que pide
`?organization_id=org-c` (donde no tiene Membership) recibe 403, igual
que cualquier otro rol.

Esto fue una decisión deliberada del diseño, no un efecto colateral:
`requireMembership` no tiene ningún caso especial por rol, así que
"`AGENCY_ADMIN` = bypass global" simplemente nunca se pudo colar —
evita exactamente el riesgo que el prompt de esta fase señaló
explícitamente ("no introducir un bypass global difícil de desmontar
después").

---

## LEGACY_SESSION_POLICY

Las ~68 sesiones de prueba escritas antes de Fase 2/3 no tienen
`organization_id`. Comportamiento explícito, implementado (no solo
documentado):

- `parseSessionRecord` en `repositories/sessions.ts` **rechaza** (trata
  como inválido/ausente) cualquier documento sin `organization_id` de
  tipo string no vacío.
- Consecuencia práctica: `listSessionsByOrganization` nunca las devuelve
  (la query de Firestore ya las excluye, al no tener el campo por el que
  filtra) y `getSessionById` sobre uno de esos ids devuelve `null` — que
  en `/session/end` se traduce en el mismo 404 uniforme que "no existe".
- **No se les asignó un tenant "legacy" silenciosamente.** Inventar una
  organización retroactiva para datos históricos sin que nadie lo pidiera
  es exactamente lo que el prompt de esta fase prohibió explícitamente.
- Si `AGENCY_ADMIN` necesitara verlas (auditoría, análisis histórico), la
  vía explícita sería un script ad-hoc con Admin SDK (como los bootstraps
  de Fase 1/2), no un endpoint de la aplicación — no se construyó ninguno
  en esta fase porque no se pidió.

---

## ALLOWLIST_DECISION

**`AUTH_ALLOWED_EMAILS` se retira en esta fase.**

Condición que el prompt pedía verificar: que `/session/start`,
`/session/end`, `/metrics/analyze`, `/admin/sessions` y `/me` queden
protegidos por *Firebase token + Membership válida + RBAC/ownership
cuando corresponda*. Confirmado, ruta por ruta:

| Ruta | requireAuth | requireMembership | RBAC/ownership |
|---|---|---|---|
| `POST /session/start` | ✓ | ✓ | — (cualquier rol puede practicar) |
| `POST /session/end` | ✓ | ✓ | ownership (starter uid) |
| `POST /metrics/analyze` | ✓ | ✓ | — |
| `GET /admin/sessions` | ✓ | ✓ | `requireAnyRole` + tenant scoping |
| `GET /me` | ✓ | ✓ | — (expone el propio contexto) |

Con esto, retirar la allowlist **no abre ningún hueco**: un usuario que se
auto-registra con la `apiKey` pública (el riesgo original que justificó
`AUTH_ALLOWED_EMAILS` en Fase 1) obtiene un token válido, pasa
`requireAuth`, pero no tiene ningún `AppUser`/`Membership` en Firestore —
`requireMembership` lo rechaza con 403 exactamente igual que antes lo
hacía la allowlist. Es la misma protección, con un solo sistema en vez de
dos paralelos, tal como se pidió ("no quiero dos sistemas permanentes de
autorización").

Cambios concretos: `backend/src/middleware/auth.ts` ya no lee ni chequea
ningún allowlist (`requireAuth` vuelve a ser identidad pura: Bearer →
verifyIdToken → uid/email → `next()`); `backend/src/config.ts` ya no
expone `authAllowedEmails`; `backend/.env`/`backend/.env.example` dejan la
variable comentada como rastro histórico, no como configuración activa.

---

## FIRESTORE_QUERIES_AND_INDEXES

| Método | Query Firestore | ¿Índice compuesto? |
|---|---|---|
| `getSessionById` | `get()` directo por id | No — no es query |
| `listSessionsByOrganization` | `where('organization_id','==',X)` | **No** — un solo `==`. Ver nota abajo sobre por qué NO se agregó `orderBy`. |
| `listSessionsByOrganizationAndUser` (repositorio, sin ruta que lo use todavía) | `where('organization_id','==',X).where('user_id','==',Y)` | **No** — dos `==` sin `orderBy` no necesitan índice compuesto (Firestore los resuelve con los índices de un solo campo que ya existen). |

**Por qué ninguna de las dos combina el filtro con `orderBy("created_at")`:**
Firestore SÍ requiere un índice compuesto cuando una query combina un
filtro de igualdad con un `orderBy` sobre un campo **distinto** — esto
casi se pasó por alto en la primera versión de este código (tenía
`.where('organization_id','==',X).orderBy('created_at','desc')`, que
habría fallado en producción con un error de "missing index" en la
primera llamada real). Se corrigió antes de este reporte: ambos métodos
ahora traen todos los documentos que matchean el filtro de igualdad (sin
`orderBy` ni `limit` a nivel Firestore) y ordenan/recortan en memoria.

Esto es correcto y proporcional para el volumen actual (68 sesiones en
total, repartidas entre organizaciones) — es una query ya *tenant-scoped*
(no "traer todo el sistema"), solo el orden final se resuelve en la
aplicación en vez de en Firestore.

**Si el volumen de sesiones por organización creciera lo suficiente para
que esto deje de ser proporcional**, el índice compuesto a crear sería:

```
Colección: sessions
Campos: organization_id (Ascending), created_at (Descending)
```

(y análogamente `organization_id` + `user_id` + `created_at` para
`listSessionsByOrganizationAndUser` si se llega a usar con `orderBy`). No
se creó ningún índice en esta fase — ninguna query lo necesita todavía.

Las queries de Fase 2 (`memberships` por `user_id` u `organization_id`,
un solo `==` cada una) siguen sin necesitar índice, sin cambios.

---

## FILES_CHANGED

**Nuevo**
- `backend/src/middleware/roles.ts` — `requireAnyRole(...)`.
- `backend/src/middleware/roles.test.ts` — 4 tests.
- `backend/src/repositories/sessions.ts` — `createSession`,
  `getSessionById`, `completeSession`, `listSessionsByOrganization`,
  `listSessionsByOrganizationAndUser`.

**Modificado**
- `backend/src/routes.ts` — `/session/start` y `/session/end` ganan
  `requireMembership`; ownership de `/session/end` ahora lee
  `getSessionById` (persistido) en vez del `Map`; `/metrics/analyze` gana
  `requireMembership`; `/admin/sessions` reescrito con RBAC + tenant
  scoping.
- `backend/src/types.ts` — `SessionRecord.organization_id`.
- `backend/src/firebase.ts` — se le quitan `saveSessionStart`/
  `saveSessionResult`/`listSessions` (movidos a
  `repositories/sessions.ts`); queda enfocado solo en el bootstrap de
  Firebase Admin.
- `backend/src/middleware/auth.ts` — se retira el chequeo de allowlist;
  `requireAuth` vuelve a ser solo verificación de identidad.
- `backend/src/config.ts` — se retira `authAllowedEmails`.
- `backend/.env`, `backend/.env.example` — `AUTH_ALLOWED_EMAILS` comentada,
  ya no leída.
- `backend/src/middleware/auth.test.ts` — se quitan los tests de
  allowlist (ese comportamiento ya no existe en este middleware).
- `backend/src/routes.test.ts` — reescrito: mocks de
  `repositories/sessions.js` en vez de las funciones de `firebase.js`;
  `express-rate-limit` mockeado (el volumen de requests de este archivo
  ya supera el límite real de 20/min compartido entre tests); tests
  nuevos de tenant isolation, ownership y RBAC.

---

## TESTS_ADDED

**`middleware/roles.test.ts` (4, nuevo):** sin `req.appContext` → 401; rol
fuera de la lista → 403; rol permitido → `next()`; caso concreto
SPOKESPERSON rechazado por una allowlist de roles admin.

**`middleware/auth.test.ts` (reescrito, 5):** se quitan los 3 tests de
allowlist (403 por email no permitido, 403 sin email, case-insensitive) —
ya no aplica a este middleware. Se agrega un test explícito de que
`requireAuth` acepta **cualquier** email válido (la autorización ya no es
su trabajo).

**`routes.test.ts` (reescrito y ampliado, cubre todos los
`SECURITY_TESTS` pedidos — ver esa sección):**
- `describe("Phase 3: session tenant ownership")` — 6 tests: persistencia
  de `organization_id` desde `appContext`; `user_id` del body ignorado +
  rechazo cruzado; éxito del dueño real; 404 uniforme para
  desconocida/ajena; 400 sin `session_id`; `CLIENT_ADMIN` sin bypass de
  ownership.
- `describe("Phase 3: GET /admin/sessions — RBAC + tenant scoping")` — 10
  tests: SPOKESPERSON 403; `CLIENT_ADMIN` solo su org;
  `COACH` solo su org; `AGENCY_ADMIN` con A+B puede pedir ambas por
  separado; sin `?organization_id` con 2 eligibles → 409 (nunca "todas");
  `AGENCY_ADMIN` sin Membership en C → 403; `organization_id` de una org
  ajena → 403 (nunca eleva); Membership/Organization/AppUser inactivos →
  403 cada uno.
- `describe("POST /metrics/analyze — requires Membership")` — 3 tests.
- Actualizados: los tests de `/session/start` y `GET /me` existentes
  (ya no dependen de `authAllowedEmails` en el mock de `config.js`).

---

## TEST_RESULTS

```
$ npm test
> npm run test --workspace=backend && npm run test --workspace=frontend

backend:  Test Files  7 passed (7) | Tests  74 passed (74)
frontend: Test Files  1 passed (1) | Tests   4 passed (4)
```

(74 backend = 55 de Fases 1–2 + 19 nuevas/reescritas de Fase 3: 4 roles +
5 auth reescritos [-3 obsoletos +2 nuevos netos] + 19 nuevos en
routes.test.ts, con algunos tests de Fase 2 removidos por quedar
obsoletos al retirar `authAllowedEmails` del mock. Los números netos no
sonarán exactos sumando fases anteriores porque varios tests de Fase 1/2
se reescribieron en vez de solo agregarse — el conteo real y autoritativo
es el de `npm test` arriba.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores
          (mismo warning preexistente de tamaño de chunk, no relacionado)
```

---

## SECURITY_TESTS

Cobertura explícita de cada caso pedido (todos en `routes.test.ts` salvo
donde se indica):

| Caso pedido | Test |
|---|---|
| User A/Org A lee sesión de Org B → 403/404 | Cubierto por el scoping de `/admin/sessions` (org-a nunca ve sesiones de org-b) + `?organization_id` ajeno → 403 |
| `CLIENT_ADMIN` Org A lista sesiones → solo Org A | `"CLIENT_ADMIN lists only sessions from their own organization"` |
| `AGENCY_ADMIN` con Membership A+B → puede consultar A y B | `"AGENCY_ADMIN with Membership in A and B can query both, one at a time"` |
| `AGENCY_ADMIN` sin Membership C → no puede consultar C | `"AGENCY_ADMIN WITHOUT Membership in C cannot query org C"` |
| SPOKESPERSON llama `/admin/sessions` → 403 | `"SPOKESPERSON -> 403"` |
| `organization_id` de Org B en body/query sin Membership B → rechazado | `"a user sending organization_id for an org they don't belong to is rejected"` + `"persists organization_id from req.appContext, never from the body"` (variante body, en `/session/start`) |
| `/session/start` → `organization_id` persistido viene de `appContext` | `"persists organization_id from req.appContext, never from the body"` |
| `/session/end` por usuario distinto al owner → rechazado | `"ignores a client-supplied user_id and rejects /session/end from a different uid"` + `"CLIENT_ADMIN cannot end a SPOKESPERSON's session..."` |
| Membership inactive → no acceso | `"Membership inactive -> no access to /admin/sessions"` (+ los ya existentes de Fase 2 en `context.test.ts`/`GET /me`) |
| Organization inactive → no acceso | `"Organization inactive -> no access to /admin/sessions"` (+ Fase 2) |
| User inactive → no acceso | `"AppUser inactive -> no access to /admin/sessions"` (+ Fase 2) |

Todos los tests anteriores (Fases 1–2) se mantienen verdes — ver
`TEST_RESULTS`.

---

## KNOWN_LIMITATIONS

- **`COACH` ve toda su organización, no solo trainees asignados.** Política
  V1 explícita, no un bug — `assignments` coach→trainee es Fase 11/12+
  (dashboard/gestión), fuera de alcance aquí.
- **`listSessionsByOrganizationAndUser` no está conectado a ninguna ruta
  todavía.** Existe en el repositorio (pedido explícitamente como
  preparación), sin endpoint que lo use en esta fase — la política V1 de
  `/admin/sessions` es a nivel de organización, no de usuario.
- **`SPOKESPERSON` no tiene ningún endpoint para listar "mis sesiones".**
  Hoy solo recibe el resultado inmediato de `/session/end` (como ya
  pasaba antes de esta fase) — un historial propio necesitaría un nuevo
  endpoint (`GET /me/sessions` o similar) que no se pidió construir en
  esta fase.
- **Ordenamiento de `/admin/sessions` en memoria, no en Firestore** (ver
  `FIRESTORE_QUERIES_AND_INDEXES`) — proporcional hoy (68 sesiones
  totales), pero un índice compuesto sería la evolución natural si el
  volumen por organización crece mucho.
- **El resto del session lifecycle sigue siendo Fase 4.** Esta fase solo
  hizo durable el ownership check específico de `/session/end` y el
  listado por organización — no hay todavía estados de abandono,
  reintentos de persistencia, ni migración de las sesiones legacy.
- **`completeSession` (el resultado final de `/session/end`) sigue siendo
  fire-and-forget**, a diferencia de `createSession` (ahora `await`ado).
  Es una decisión deliberada (ver `SESSION_OWNERSHIP`/comentario en
  `routes.ts`): la integridad de tenant/ownership ya quedó establecida de
  forma durable en `/session/start`; si `completeSession` falla, el peor
  caso es una sesión que queda "in_progress" en Firestore con resultados
  obsoletos — no un problema de seguridad.
- **`GET /admin/sessions` no expone ningún filtro adicional** (por fecha,
  por usuario, por escenario) — solo `organization_id` (+ el propio
  `?organization_id` para elegir cuál). Cualquier filtro adicional es
  trabajo de dashboard (Fase 11), fuera de alcance.

---

## SECURITY_NOTES

- **404 uniforme en `/session/end`, deliberado.** Una sesión inexistente y
  una sesión de otra persona devuelven exactamente la misma respuesta
  (`404 {"error": "Sesión no encontrada"}`) — evita que un caller pueda
  usar la diferencia entre "no existe" y "no es tuya" para enumerar
  `session_id` reales de otras personas.
- **Ningún rol tiene bypass de ownership en `/session/end`.** Se consideró
  explícitamente y se descartó — ver `SESSION_OWNERSHIP`. El acceso
  administrativo a resultados vive en `/admin/sessions` (lectura,
  tenant-scoped), nunca mutando/completando la sesión de otra persona.
- **`AGENCY_ADMIN` nunca tiene un camino de bypass global** — ver
  `AGENCY_ADMIN_BOUNDARY`. No existe ningún `if (role === "AGENCY_ADMIN")
  { /* saltar el chequeo de membership */ }` en el código.
- **Retirar `AUTH_ALLOWED_EMAILS` no reabre el riesgo de auto-registro**
  de Fase 1 — ver `ALLOWLIST_DECISION`: `requireMembership` da la misma
  protección con una sola fuente de verdad.
- **`createSession` se volvió `await`ado** (antes fire-and-forget) — es el
  único punto de esta fase donde se agregó una escritura de Firestore al
  camino crítico de una respuesta al cliente. Trade-off deliberado:
  latencia de un solo `set()` pequeño a cambio de que la integridad de
  tenant/ownership sea garantizada antes de que el cliente reciba el
  `signed_url` y pueda empezar a hablar con ElevenLabs.
- **`GET /admin/sessions` nunca construye una query sin filtro de
  organización.** No hay ningún código camino que ejecute
  `collection("sessions").get()` sin `.where("organization_id", "==", ...)`
  primero.

---

## MIGRATION_NOTES

- **Nada de esto está desplegado.** Producción sigue en el commit de
  Fase 0 (login hardcoded). El VPS y Firebase Hosting no tienen ninguno
  de los cambios de Fases 1–3 todavía.
- **No se requiere ninguna migración de datos para desplegar esta fase**:
  las sesiones legacy simplemente quedan invisibles a las rutas nuevas
  (ver `LEGACY_SESSION_POLICY`), no se tocan ni se necesitan tocar.
- **No se requiere ningún índice compuesto nuevo en Firestore** para
  desplegar esta fase (ver `FIRESTORE_QUERIES_AND_INDEXES`).
- **Variables de entorno:** `AUTH_ALLOWED_EMAILS` puede eliminarse de
  `backend/.env` en el VPS al desplegar (ya no se lee; dejarla no rompe
  nada, pero ya no protege nada tampoco).
- **Antes de desplegar**, confirmar con `GET /admin/sessions` autenticado
  como cada uno de los 4 usuarios bootstrap (todos `AGENCY_ADMIN` en
  `smartpr-interno-legacy`) que la ruta responde 200 con `sessions: []`
  (esperado: las sesiones nuevas empiezan desde cero para este modelo;
  las 68 legacy no aparecerán, por diseño).
- **Frontend: cero cambios necesarios en esta fase.** Verificado contra el
  estado real de Firestore: los 4 usuarios bootstrap tienen exactamente
  una Membership cada uno, así que `requireMembership` siempre resuelve
  automáticamente (rama "1 elegible") — ningún flujo actual necesita
  enviar `?organization_id`. Si en el futuro alguien tiene 2+ memberships,
  `/session/start`/`/metrics/analyze` fallarían con 409
  (`selection_required`) y el frontend necesitaría un selector de
  organización mínimo — no construido en esta fase porque hoy no hace
  falta (“mínimo funcional necesario” = nada, verificado).

---

## OPEN_ITEMS

- [ ] Revisar y aprobar este reporte.
- [ ] Desplegar Fases 1–3 juntas (frontend + backend) tras la aprobación.
- [ ] Fase 4: session lifecycle durable completo — estados de abandono,
      reintentos de persistencia, formalizar qué pasa si `completeSession`
      falla de verdad.
- [ ] Fase 4 o posterior: decidir si migrar/exponer las sesiones legacy de
      alguna forma explícita (hoy quedan invisibles a propósito).
- [ ] Cuando exista un caso real de usuario con 2+ memberships: construir
      el selector de organización mínimo en el frontend (`?organization_id`)
      — el backend ya lo soporta end-to-end (`/me`, `/admin/sessions`,
      `/session/start`, `/metrics/analyze`).
- [ ] Endpoint de "mis sesiones" para SPOKESPERSON (historial propio) —
      no pedido en esta fase, útil eventualmente.
- [ ] Si el volumen de sesiones por organización crece: crear el índice
      compuesto documentado en `FIRESTORE_QUERIES_AND_INDEXES` y volver a
      usar `orderBy` a nivel Firestore.
- [ ] `assignments` coach→trainee, permisos granulares — explícitamente
      fuera de esta fase, quedan para cuando el dashboard (Fase 11+) los
      necesite de verdad.

---

## PHASE_03_FIXES_ADDENDUM (round `PASS_WITH_FIXES`)

La revisión encontró un hueco real en `SESSION_OWNERSHIP`: el chequeo de
`/session/end` verificaba `stored.owner_uid === req.auth.uid` pero **no**
`stored.organization_id === req.appContext.organizationId`. Con eso, un
mismo uid con Membership activa en Org A y Org B podía iniciar una sesión
bajo el contexto A y luego terminarla llamando
`/session/end?organization_id=B` — el chequeo por uid pasaba igual,
aunque el recurso pertenece a A y el contexto autorizado de esa request
específica es B.

**Fix:** el chequeo ahora exige ambas condiciones a la vez:

```ts
if (
  !stored ||
  stored.owner_uid !== req.auth!.uid ||
  stored.organization_id !== req.appContext!.organizationId
) {
  return res.status(404).json({ error: "Sesión no encontrada" });
}
```

Las tres causas de rechazo (sesión inexistente, uid distinto,
organización distinta a la autorizada en esta request) devuelven el
**mismo 404 uniforme** — se mantiene la protección anti-enumeración
descrita en `SECURITY_NOTES`, ahora extendida a este caso.

**Tests nuevos** (`routes.test.ts`, dentro de
`describe("Phase 3: session tenant ownership")`):
1. Un uid con Membership en A y B inicia una sesión bajo contexto A y
   luego intenta terminarla con `?organization_id=B` → **404**.
2. El mismo uid termina la misma sesión con `?organization_id=A` (su
   contexto real) → **200**.

No se tocó nada más de la arquitectura de esta fase — mismo modelo,
mismo contrato de `requireMembership`, mismo 404 uniforme, sin bypass por
rol. No se avanzó a Fase 4. No se desplegó.

```
$ npm test
backend:  Test Files  7 passed (7) | Tests  76 passed (76)   (antes 74)
frontend: Test Files  1 passed (1) | Tests   4 passed (4)

$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores
```

---

**Commit de código de esta fase:** `6ba4e12e472b4af10e35d05f570715593744fd61`
**Commit de este fix:** `4c4072d39734b666352d03b52ac817c3bc8d1393`
**Este reporte:** commiteado por separado, después del código.
