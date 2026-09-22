# PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 2 de 15 — Organization + Membership + Roles
**Fecha:** 22 de septiembre de 2026
**Commit base aprobado (Fase 1):** `d017db004c45fe1d6770bf9a0298f855363393b0`
**Código de esta fase:** `bf4036d2fb2cb804a96c42578d07e5626d5b948a`
**Estado:** implementado, testeado y buildeado localmente. Bootstrap corrido
contra Firestore real. **NO desplegado.**

---

## WHAT_CHANGED

Se construyó el modelo base multi-cliente encima de la identidad de
Firebase Auth ya aprobada:

```
Firebase User (uid verificado por requireAuth, Fase 1)
    ↓
AppUser (Firestore: users/{uid} — metadata, nunca password)
    ↓
Membership (Firestore: memberships/{uid}::{orgId} — vínculo + role)
    ↓
Organization (Firestore: organizations/{orgId})
    ↓
Role (AGENCY_ADMIN | CLIENT_ADMIN | COACH | SPOKESPERSON)
```

`resolveAppContext(uid, email)` deriva `{userId, email, organizationId,
role}` **exclusivamente** desde Firestore, nunca desde el request. Se
expone vía el nuevo endpoint `GET /me`.

**Deliberadamente NO se tocó ninguna otra ruta.** `/session/start`,
`/session/end`, `/metrics/analyze` y `/admin/sessions` siguen exactamente
igual que al cierre de Fase 1 (protegidas solo por `requireAuth` +
allowlist). No hay tenant isolation, no hay RBAC por endpoint, no hay
filtrado de sesiones por organización — eso es Fase 3, tal como se pidió
explícitamente. Esta fase construye el modelo y demuestra que la
resolución funciona; no lo aplica todavía a los recursos existentes.

---

## DOMAIN_MODEL

Los cuatro tipos nuevos viven en `backend/src/types.ts`:

```ts
export type Role = "AGENCY_ADMIN" | "CLIENT_ADMIN" | "COACH" | "SPOKESPERSON";
export type EntityStatus = "active" | "inactive";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: EntityStatus;
  created_at: string; // ISO 8601
  updated_at: string;
}

export interface AppUser {
  uid: string;          // Firebase uid — mismo id space
  email: string | null;
  display_name: string | null;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  id: string;            // == membershipId(user_id, organization_id)
  user_id: string;       // Firebase uid
  organization_id: string;
  role: Role;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
}

export interface AppContext {
  userId: string;
  email: string | null;
  organizationId: string;
  role: Role;
}
```

**Decisiones deliberadas de alcance:**
- `Organization` no tiene ningún campo de configuración de cliente
  (escenarios, rúbricas, prompts, voces). Eso es explícitamente Fase 5
  (ENGINE vs CONFIG) — agregarlo ahora habría sido "meter configuración de
  cliente en esta entidad", que el prompt de esta fase prohibió.
- `AppUser` no guarda ni referencia ninguna contraseña. Firebase Auth sigue
  siendo la única autoridad de autenticación; Firestore es la autoridad de
  pertenencia y rol, no de credenciales.
- `Membership` no tiene campos de "asignación" (p. ej. coach→trainees). El
  prompt pidió explícitamente no construir assignments todavía.

---

## FIRESTORE_SCHEMA

Tres colecciones raíz, la estructura equivalente que el prompt sugirió:

```
organizations/{organizationId}
users/{uid}
memberships/{membershipId}
```

**`organizationId`** es el slug elegido al crear la organización (no un id
autogenerado aleatorio) — así el bootstrap es reproducible: correrlo dos
veces apunta al mismo documento en vez de crear duplicados.

**`membershipId` es determinístico:** `${user_id}::${organization_id}`
(implementado en `backend/src/repositories/memberships.ts`). Esta es la
decisión de diseño central de esta fase y justifica por qué las tres
consultas que el prompt pidió salen simples y eficientes sin necesitar
índices compuestos:

| Consulta pedida | Cómo se resuelve | Costo |
|---|---|---|
| Rol del usuario dentro de la organización | `get()` directo por `membershipId(uid, orgId)` | O(1), sin query |
| Memberships por usuario | `where('user_id', '==', uid)` | equality de un campo, auto-indexada |
| Memberships por organización | `where('organization_id', '==', orgId)` | equality de un campo, auto-indexada |

Y, más importante: el id determinístico hace que **"la combinación
usuario + organización debe ser inequívoca" sea una garantía estructural,
no una regla que haya que verificar.** Escribir una membership para el
mismo par siempre apunta al mismo documento (`set({ merge: true })`), así
que es imposible terminar con dos documentos para el mismo par — no hay
nada que "chequear" en tiempo de escritura, a diferencia de usar ids
autogenerados + una query de unicidad antes de cada insert (que además
sería una condición de carrera sin una transacción).

**Validación runtime:** cada repositorio (`organizations.ts`, `users.ts`,
`memberships.ts`) valida la forma del documento leído antes de confiar en
él (`parseOrganization`, `parseUser`, `parseMembership`). Un documento
malformado (edición manual, bug futuro de migración) se loguea y se trata
como ausente/se descarta de la lista, en vez de propagar un crash o datos
con forma incorrecta más arriba en la aplicación. No se agregó ninguna
dependencia nueva (zod, etc.) — son funciones de validación manuales,
proporcionales al tamaño real de estos documentos.

No se configuró ningún índice compuesto — no hace falta con las queries
de esta fase (equality de un solo campo). El prompt pidió explícitamente
no sobreoptimizar índices todavía.

---

## ROLE_MODEL

```ts
type Role = "AGENCY_ADMIN" | "CLIENT_ADMIN" | "COACH" | "SPOKESPERSON";
```

Es un union type, no un documento ni una colección — no hay "gestión de
roles" en esta fase (eso podría ser parte de Fase 12, gestión de
configuración). El rol vive **exclusivamente** como campo de `Membership`,
nunca en `AppUser` ni en el token de Firebase, exactamente como pidió el
prompt.

**No se implementó ninguna lógica de permisos** más allá de "resolver cuál
es el rol". Ninguna ruta usa el rol todavía para decidir qué puede hacer
cada quien — eso es explícitamente Fase 3 ("La Fase 2 construye el
modelo. La Fase 3 lo aplica rigurosamente a los recursos/endpoints").

---

## MEMBERSHIP_RESOLUTION

`backend/src/services/context.ts` — `resolveAppContext(userId, email,
listMembershipsByUser?)`:

1. Lista las memberships del `uid` (ya verificado por `requireAuth`).
2. Filtra las que tengan `status === "active"`.
3. Si no hay ninguna activa → devuelve `null` (rechazo explícito).
4. Si hay una o más → aplica la estrategia de selección (ver
   `AGENCY_ADMIN_MODEL` abajo) y devuelve el contexto de esa membership.

`backend/src/middleware/context.ts` — `requireMembership` (se monta
después de `requireAuth`):

1. Si `req.auth` no existe (bug de wiring: `requireMembership` sin
   `requireAuth` antes) → 401, sin intentar resolver nada.
2. Llama a `resolveAppContext(auth.uid, auth.email)`.
3. Si devuelve `null` → **403** `"Tu usuario no pertenece a ninguna
   organización"` — distinguible por mensaje del 403 de allowlist de Fase
   1, para poder diagnosticar cuál de las dos capas está rechazando.
4. Si devuelve un contexto → lo adjunta en `req.appContext` y llama a
   `next()`.

Ambos siguen el mismo patrón inyectable que `requireAuth` de Fase 1
(`createRequireAuth(verifyIdToken)` / `createRequireMembership(resolve)`),
por consistencia de estilo y para poder testear sin Firestore real.

---

## AGENCY_ADMIN_MODEL

El requisito era explícito: `User = una sola Organization fija para
siempre` está prohibido, porque `AGENCY_ADMIN` eventualmente necesita
trabajar sobre varias organizaciones.

**Decisión:** el vínculo vive en `Membership`, no en `User` — un mismo uid
puede tener N documentos `Membership`, uno por organización, cada uno con
su propio `role`. `AGENCY_ADMIN` no tiene ningún modelo de datos especial
distinto de `CLIENT_ADMIN`/`COACH`/`SPOKESPERSON`: es simplemente el valor
de `role` en una Membership como cualquier otra. Nada en el esquema le
impide a un usuario tener una Membership `AGENCY_ADMIN` en una
organización y `COACH` en otra, si algún día hiciera falta.

**MULTI_MEMBERSHIP_SELECTION_STRATEGY (temporal, documentada y testeada):**
esta fase NO construye una forma de que el frontend elija cuál de sus
memberships está "activa" — no hay UI ni endpoint para eso, y dejar que el
cliente la elija es explícitamente un tema de Fase 3+ (y aun así tendría
que verificarse contra las memberships reales del usuario, nunca
confiarse a ciegas). Mientras tanto, `resolveAppContext` elige
determinísticamente **la Membership activa más antigua** (`created_at`
ascendente) cuando hay más de una. Es arbitraria pero estable y
testeada (`services/context.test.ts`, `routes.test.ts` → `GET /me`). No
implica que el modelo colapse a "una organización por usuario": un
usuario con N memberships sigue teniendo N documentos en Firestore — solo
decide qué ve hoy un caller de un solo contexto como `GET /me`.

Con los 4 usuarios bootstrap, este caso ni siquiera se activa todavía:
cada uno tiene exactamente una Membership (en `smartpr-interno-legacy`),
así que la estrategia de selección es un no-op para el estado real actual —
pero está implementada y testeada para cuando deje de serlo.

---

## BOOTSTRAP_STRATEGY

`backend/scripts/bootstrap-phase2-legacy-org.ts` — **corrido dos veces
contra el Firestore real del proyecto** (`smartpr-pitch-agent`) para
verificar idempotencia.

**Organization elegida:** `smartpr-interno-legacy` / *"SmartPR — Interno
(Legacy MVP)"*. Nombre explícito a propósito: dice que es un contenedor de
arranque (no un cliente real) y que es el estado heredado del MVP
pre-Fase-2.

**Los 4 usuarios de Fase 1** (`gerardo.calambas`, `daniel.espana`,
`fabian.motta`, `juan.motta`, todos `@smartpr.com.co`) reciben Membership
`AGENCY_ADMIN` en esa organización. Razonamiento: son el equipo interno de
la agencia (SmartPR), no un cliente externo — exactamente lo que
`AGENCY_ADMIN` representa ("usuario interno de agencia"). Es un default de
bootstrap, no una decisión de negocio definitiva: ajustar roles reales
(quién debería ser `CLIENT_ADMIN`/`COACH`/`SPOKESPERSON` de qué) queda
fuera del alcance de esta fase.

**Reproducibilidad:** el script resuelve el `uid` de cada usuario
consultando Firebase Auth por email (`admin.auth().getUserByEmail`) en vez
de tener uids hardcodeados, y cada escritura es un upsert contra un id
determinístico (`organizations/smartpr-interno-legacy`,
`memberships/{uid}::smartpr-interno-legacy`). Correrlo de nuevo no crea
duplicados ni pierde el `created_at` original — verificado leyendo los
documentos después de la segunda corrida:

```
org.created_at   = 2026-09-22T18:39:09.554Z  (primera corrida)
org.updated_at   = 2026-09-22T18:39:19.658Z  (segunda corrida)
```

**No guarda ni imprime ningún secreto.** Solo lee uids/emails (ya
públicos dentro del proyecto) y escribe documentos de aplicación sin
contraseñas ni tokens.

---

## ALLOWLIST_DECISION

`AUTH_ALLOWED_EMAILS` (Fase 1) **se mantiene sin cambios.**

Razón: ninguna ruta de recursos (`/session/*`, `/metrics/analyze`,
`/admin/sessions`) fue modificada para exigir `requireMembership` en esta
fase — siguen protegidas únicamente por `requireAuth` (token válido +
allowlist). Si se retirara la allowlist ahora, esas rutas quedarían
protegidas solo por "cualquier Firebase Auth token válido", lo cual es
**menos** seguro que hoy (el proveedor email/password permite
auto-registro — ver `PHASE_01...SECURITY_NOTES`), no más. La resolución de
Membership sí funciona y está probada (`GET /me`), pero probarla no es lo
mismo que aplicarla como control de acceso a los recursos reales.

**Se retira cuando Fase 3 reemplace, ruta por ruta, el control de
`requireAuth`-solo por `requireAuth` + `requireMembership` (+ el rol/la
organización que corresponda).** Hasta entonces, mantenerla es
defense-in-depth explícito, no un descuido. No hay dos sistemas
permanentes de autorización conviviendo: hay un sistema (allowlist) que
sigue siendo el único que efectivamente protege recursos hoy, y un segundo
sistema (Membership) que ya existe y está probado, pero que todavía no
reemplaza al primero en ningún endpoint de recursos.

---

## FILES_CHANGED

**Dominio**
- `backend/src/types.ts` — `Role`, `EntityStatus`, `Organization`,
  `AppUser`, `Membership`, `AppContext`.

**Repositorios (Firestore)**
- `backend/src/repositories/organizations.ts` (nuevo) — `getOrganization`,
  `upsertOrganization`.
- `backend/src/repositories/users.ts` (nuevo) — `getUser`, `upsertUser`.
- `backend/src/repositories/memberships.ts` (nuevo) — `membershipId`,
  `getMembership`, `listMembershipsByUser`, `listMembershipsByOrganization`,
  `upsertMembership`.

**Servicio + middleware**
- `backend/src/services/context.ts` (nuevo) — `resolveAppContext`,
  estrategia de selección multi-membership.
- `backend/src/middleware/context.ts` (nuevo) — `requireMembership`,
  `createRequireMembership`.

**Rutas**
- `backend/src/routes.ts` — nuevo `GET /me` (`requireAuth` +
  `requireMembership`). Ninguna otra ruta cambió de comportamiento.

**Bootstrap**
- `backend/scripts/bootstrap-phase2-legacy-org.ts` (nuevo, committeado —
  no contiene secretos).
- `backend/package.json` — script `bootstrap:phase2-legacy-org`.

**Tests**
- `backend/src/services/context.test.ts` (nuevo, 5 tests).
- `backend/src/middleware/context.test.ts` (nuevo, 3 tests).
- `backend/src/routes.test.ts` — 6 tests nuevos para `GET /me`.

---

## TESTS_ADDED

**`services/context.test.ts` (unitario, resolver inyectado, sin
Firestore):**
1. Usuario conocido + Membership activa → contexto correcto
   (`{userId, email, organizationId, role}` exactos).
2. Usuario sin ninguna Membership → `null` (rechazo seguro).
3. Membership inactiva → `null` ("no válida").
4. Dos memberships activas (distinto `created_at`, orden de entrada
   invertido) → no rompe, elige la más antigua determinísticamente.
5. Una membership inactiva (más antigua) + una activa (más reciente) → se
   ignora la inactiva, gana la activa.

**`middleware/context.test.ts` (unitario, resolver inyectado, sin
Express real):**
1. `req.auth` ausente (wiring incorrecto) → 401, resolver ni se llama.
2. Resolver devuelve `null` → 403, `next()` no se llama.
3. Resolver devuelve contexto → `req.appContext` seteado, `next()`
   llamado.

**`routes.test.ts` → `describe("GET /me ...")` (integración, con
`supertest`, Firestore mockeado vía `./repositories/memberships.js`):**
1. Sin token → 401.
2. Token válido y permitido, sin Membership → 403.
3. Única Membership inactiva → 403.
4. Membership activa real → 200 con `organizationId`/`role` exactos de
   Firestore.
5. **`organization_id`/`role` enviados en el body del request → ignorados
   por completo** — la respuesta refleja únicamente lo que devolvió el
   repositorio mockeado, nunca lo que mandó el cliente.
6. Dos memberships activas → no rompe, responde 200 con la más antigua
   (mismo criterio que el test unitario, pero de punta a punta a través
   de Express).

---

## TEST_RESULTS

```
$ npm test
> npm run test --workspace=backend && npm run test --workspace=frontend

backend:  Test Files  5 passed (5) | Tests  31 passed (31)
frontend: Test Files  1 passed (1) | Tests   4 passed (4)
```

(31 backend = 17 de Fase 1 + 14 nuevas de Fase 2.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores
          (mismo warning preexistente de tamaño de chunk, no relacionado)
```

El script de bootstrap (`backend/scripts/bootstrap-phase2-legacy-org.ts`)
no está dentro de `rootDir` de `tsc` (solo `src/**/*`), así que **no** lo
cubre `npm run build`. Se type-checkeó aparte con la misma configuración
de compilador (`strict`, `ES2022`, `bundler`) antes de correrlo — sin
errores — y además se ejecutó de verdad dos veces contra Firestore, lo
cual es una verificación más fuerte que un type-check solo.

---

## KNOWN_LIMITATIONS

- **Ninguna ruta de recursos aplica Membership todavía.**
  `/session/start`, `/session/end`, `/metrics/analyze` y
  `/admin/sessions` siguen sin tenant isolation ni RBAC — protegidas solo
  por `requireAuth`. Esto es exactamente lo que se pidió dejar así para
  esta fase ("La Fase 2 construye el modelo. La Fase 3 lo aplica"). No se
  debe marcar como resuelto ni como regresión: es el alcance acordado.
- **`GET /admin/sessions` sigue siendo el `OPEN_P0` de Fase 1**, sin
  cambios — cualquier usuario allowlisted sigue viendo todas las
  sesiones de todos. `GET /me` no lo toca.
- **La estrategia de selección multi-membership es un placeholder
  deliberado**, no una decisión final de producto. Hoy no importa (los 4
  usuarios bootstrap tienen una sola Membership cada uno), pero en cuanto
  exista un segundo cliente real y algún `AGENCY_ADMIN` tenga más de una
  Membership, esta regla ("la más antigua gana") empezará a importar de
  verdad y probablemente haya que reemplazarla por selección explícita
  (verificada) desde el frontend.
- **No se valida `Organization.status` al resolver el contexto.** Si una
  organización se marcara `inactive`, sus memberships seguirían
  resolviendo contexto igual — el chequeo de `status` hoy solo mira la
  Membership, no la Organization a la que apunta. Aceptable para esta
  fase (es un tema de autorización/negocio, no de identidad), pero vale
  la pena cerrarlo en Fase 3.
- **Los repositorios de Firestore (`repositories/*.ts`) no tienen tests
  unitarios propios** que mockeen las llamadas a `admin.firestore()`
  directamente (`where`, `get`, `set`...) — se probaron indirectamente
  corriendo el bootstrap dos veces contra Firestore real (ver
  BOOTSTRAP_STRATEGY) y a través del mock de módulo completo en
  `routes.test.ts`. Montar un emulador de Firestore para tests de
  integración más finos queda fuera de alcance de esta fase.
- **`AppUser.display_name` queda `null`** para los 4 usuarios bootstrap —
  no había ninguna fuente confiable de nombre de despliegue en Firebase
  Auth (se crearon solo con email en Fase 1). No bloquea nada hoy.

---

## SECURITY_NOTES

- `organizationId` y `role` **nunca** se leen del request en ningún punto
  del código nuevo — `resolveAppContext` no recibe ni el body ni la query
  como parámetros, solo `uid`/`email` ya verificados por `requireAuth`. El
  test "ignora organization_id/role enviados por el cliente" en
  `routes.test.ts` lo prueba enviando un body con esos campos falsificados
  contra `GET /me` y confirmando que la respuesta no los refleja.
- El 403 de "sin Membership" usa un mensaje distinto al 403 de allowlist
  de Fase 1, para que los logs/monitoreo puedan distinguir "no está en la
  lista permitida" de "está permitido pero no pertenece a ninguna
  organización" — son fallas de naturaleza distinta.
- El bootstrap no imprime ni persiste ningún secreto (ni siquiera
  temporalmente) — solo uids, emails y roles, todos ya conocidos/públicos
  dentro del propio proyecto.
- Como se documentó en `ALLOWLIST_DECISION`, mantener
  `AUTH_ALLOWED_EMAILS` activa es intencional: hoy sigue siendo el único
  control de acceso real sobre los recursos. Confundir "el modelo de
  Membership existe" con "el modelo de Membership protege algo" sería el
  error de seguridad más probable de esta fase — por eso se documenta de
  forma tan explícita.

---

## MIGRATION_NOTES

- **Nada de esto está desplegado.** El VPS y Firebase Hosting siguen
  corriendo el código de Fase 1 (`d017db0`). Lo único que tocó el mundo
  real fue el bootstrap contra Firestore (documentos nuevos en
  `organizations`, `users`, `memberships`) — el backend en producción ni
  siquiera tiene el código para leerlos todavía.
- **Variables de entorno:** ninguna nueva. `AUTH_ALLOWED_EMAILS` sigue
  siendo la única relevante para auth; Membership no necesita
  configuración adicional (usa el mismo `FIREBASE_SERVICE_ACCOUNT_PATH`
  que ya existía).
- **Antes de desplegar esta fase**, correr
  `npm run bootstrap:phase2-legacy-org --workspace=backend` contra el
  Firestore de producción (ya se hizo en este entorno, que apunta al
  mismo proyecto `smartpr-pitch-agent` — no hace falta repetirlo salvo
  que se cambie de proyecto Firebase). Confirmar con `GET /me` autenticado
  que cada uno de los 4 usuarios resuelve `organizationId:
  "smartpr-interno-legacy"`, `role: "AGENCY_ADMIN"`.
- Si se crea un usuario Firebase nuevo (Fase 1) sin correr ningún
  bootstrap para él, `GET /me` le dará 403 ("no pertenece a ninguna
  organización") aunque esté en `AUTH_ALLOWED_EMAILS` — son dos capas
  independientes a propósito.

---

## OPEN_ITEMS

- [ ] Revisar y aprobar este reporte.
- [ ] Fase 3: tenant isolation real — aplicar `requireMembership` (+
      chequeo de rol/ownership) a `/session/start`, `/session/end`,
      `/metrics/analyze` y, sobre todo, cerrar el P0 de
      `/admin/sessions`.
- [ ] Fase 3: decidir y reemplazar la estrategia de selección
      multi-membership por algo verificable desde el frontend (org
      switcher), cuando exista un caso real que la necesite.
- [ ] Fase 3: evaluar si conviene chequear `Organization.status` al
      resolver contexto.
- [ ] Fase 3 (o antes, si conviene): retirar `AUTH_ALLOWED_EMAILS` una
      vez que Membership sea el control de acceso real en todas las
      rutas de recursos.
- [ ] Eventualmente: `display_name` real para los 4 usuarios bootstrap
      (hoy `null`).

---

## DECISIONES DE ARQUITECTURA QUE CONDICIONAN FASE 3

1. **`GET /me` ya existe y su contrato (`{userId, email, organizationId,
   role}`) es lo que Fase 3 debería reutilizar** en vez de inventar un
   contexto distinto — construir autorización por endpoint sobre esta
   misma forma evita una segunda fuente de verdad.
2. **El id determinístico de Membership (`uid::orgId`) hace que "¿este uid
   pertenece a esta organización, y con qué rol?" sea un `get()` directo**,
   no una query — Fase 3 puede (y probablemente deba) apoyarse en eso para
   autorización rápida por recurso, en vez de repetir
   `listMembershipsByUser` en cada request.
3. **La estrategia de selección multi-membership es el punto más frágil
   de cara a Fase 3.** Mientras `AGENCY_ADMIN` con más de una
   organización sea un caso real (no solo teórico), Fase 3 necesita
   decidir explícitamente cómo se elige/cambia de organización activa —
   hoy es "la más antigua gana" y punto, lo cual alcanza para el bootstrap
   pero no para un agency admin operando varios clientes a la vez.
4. **`Organization.status` no bloquea nada hoy** — si Fase 3 empieza a
   confiar en Membership para autorizar, probablemente deba empezar a
   chequear también que la Organization de esa Membership siga `active`.

---

**Commit de código de esta fase:** `bf4036d2fb2cb804a96c42578d07e5626d5b948a`
**Este reporte:** commiteado por separado, después del código.
