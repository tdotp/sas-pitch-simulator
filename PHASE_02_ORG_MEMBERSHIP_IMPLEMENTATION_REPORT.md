# PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 2 de 15 — Organization + Membership + Roles
**Fecha:** 22 de septiembre de 2026
**Commit base aprobado (Fase 1):** `d017db004c45fe1d6770bf9a0298f855363393b0`
**Código original de esta fase:** `bf4036d2fb2cb804a96c42578d07e5626d5b948a`
**Código con los fixes del round `PASS_WITH_FIXES`:** `5a34b26356630774ce616d8155e1eac14d503fe2`
**Estado:** revisión técnica recibida (`PASS_WITH_FIXES`), los 4 fixes
pedidos ya están implementados y testeados. **Pendiente del PASS final —
no se declara la fase cerrada hasta recibirlo.** Implementado, testeado y
buildeado localmente; bootstrap corrido contra Firestore real. **NO
desplegado.**

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

**`membershipId` es determinístico:**
`encodeURIComponent(user_id) + "::" + encodeURIComponent(organization_id)`
(implementado en `backend/src/repositories/memberships.ts`). Esta es la
decisión de diseño central de esta fase y justifica por qué las tres
consultas que el prompt pidió salen simples y eficientes sin necesitar
índices compuestos:

> **Corrección (revisión PASS_WITH_FIXES):** la primera versión era
> `${user_id}::${organization_id}` sin codificar, con el comentario "`::`
> no puede aparecer en un uid de Firebase ni en los ids tipo slug que este
> proyecto genera" — una suposición nunca forzada por el código. La
> revisión señaló correctamente que dos pares distintos podían colisionar
> si `::` apareciera dentro de alguno de los dos componentes (p. ej.
> `userId="a::b", organizationId="c"` y `userId="a", organizationId="b::c"`
> generaban el mismo id). El fix codifica cada componente con
> `encodeURIComponent` antes de unirlo: esa función nunca produce un `:`
> literal (siempre lo escapa a `%3A`), así que el separador `::` solo
> puede aparecer como tal, nunca dentro de un componente — la colisión es
> estructuralmente imposible para cualquier input, no solo para los que
> hoy esperamos ver. Test de no-colisión en
> `backend/src/repositories/membershipId.test.ts`. Para los datos reales ya
> escritos (uids de Firebase y el slug `smartpr-interno-legacy`, que solo
> usan caracteres que `encodeURIComponent` no toca) el id resultante es
> **idéntico byte a byte** al anterior — no hizo falta ninguna migración de
> datos, verificado también en ese mismo test.

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

**Reescrito en la revisión PASS_WITH_FIXES.** La versión original devolvía
`AppContext | null` y, con varias memberships activas, elegía una sola
"arbitrariamente pero de forma determinística" (la más antigua). La
revisión rechazó esa elección arbitraria explícitamente. El contrato
correcto y ya implementado:

```ts
type ContextResolution =
  | { type: "ok"; context: AppContext }
  | { type: "no_membership" }
  | { type: "selection_required"; organizationIds: string[] }
  | { type: "forbidden_organization" };
```

`backend/src/services/context.ts` — `resolveAppContext(userId, email,
requestedOrganizationId, deps?)`:

1. Lee el `AppUser` (`deps.getUser`). Si no existe o `status !== "active"`
   → `no_membership` (mismo resultado que "no tiene memberships": no hay
   nada válido que otorgar de todas formas).
2. Lista las memberships del `uid` (`deps.listMembershipsByUser`) y filtra
   `status === "active"`.
3. Para cada una, verifica que su `Organization` también esté activa
   (`deps.getOrganization`) — solo las que pasan ambos chequeos son
   **elegibles**.
4. **0 elegibles** → `no_membership`.
5. **`requestedOrganizationId` presente:** busca entre las elegibles la que
   coincide. Si no está → `forbidden_organization` (rechazo explícito; el
   id solicitado es una selección, nunca una autoridad — nunca cae de
   vuelta a otra organización del usuario ni a la que sea). Si está → `ok`
   con esa membership.
6. **Sin `requestedOrganizationId`, exactamente 1 elegible** → `ok`
   automáticamente.
7. **Sin `requestedOrganizationId`, 2+ elegibles** → `selection_required`
   con la lista de `organizationIds` entre las que puede elegir — **nunca
   se elige una arbitrariamente.**

`backend/src/middleware/context.ts` — `requireMembership` (se monta
después de `requireAuth`; lee `req.query.organization_id` como la
selección solicitada, si viene):

1. Si `req.auth` no existe (bug de wiring) → 401, sin intentar resolver
   nada.
2. Llama a `resolveAppContext(auth.uid, auth.email, organizationIdSolicitado)`
   **dentro de un `try/catch`.** Si el resolver lanza/rechaza (p. ej.
   Firestore no responde) → **falla cerrado**: loguea internamente el
   error real, responde **503** genérico (`"No se pudo resolver tu
   organización. Intenta de nuevo."`, sin exponer el mensaje/stack real), y
   **nunca llama a `next()`.** Este era exactamente el gap que la revisión
   señaló: antes, un `resolve()` que lanzara habría propagado la excepción
   sin control (Express la habría convertido en un 500 genérico del
   framework, sin logging propio ni garantía explícita de no seguir a
   `next()`).
3. Según el `type` de la resolución: `ok` → adjunta `req.appContext` y
   `next()`; `no_membership` → 403; `selection_required` → **409**
   (petición ambigua, no "no autorizado") con `organization_ids` en el
   body; `forbidden_organization` → 403.

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

**MULTI_MEMBERSHIP_SELECTION (corregida en la revisión PASS_WITH_FIXES):**
la primera versión elegía "la Membership activa más antigua" cuando había
más de una — una elección arbitraria que la revisión rechazó
correctamente ("con múltiples memberships activas no se debe seleccionar
una organización arbitrariamente"). El comportamiento correcto, ya
implementado:

- **0 elegibles** → rechazo (`no_membership`).
- **1 elegible** → contexto automático, sin que el cliente tenga que pedir
  nada.
- **2+ elegibles, sin selección** → `selection_required` (**409**, con la
  lista de `organizationIds` posibles) — nunca se adivina cuál quiere el
  caller.
- **2+ elegibles, con `?organization_id=X` solicitado** → si `X` es una de
  las memberships elegibles del propio `uid` (verificado server-side
  contra Firestore, nunca contra lo que dice el request), se devuelve el
  contexto de `X`. Si `X` **no** es una de sus memberships elegibles →
  `forbidden_organization` (**403**) — el id solicitado es una selección
  entre las organizaciones propias del usuario, nunca una autoridad; jamás
  se confía ni se cae de vuelta a otra organización.

Esta fase sigue sin construir ninguna UI/org-switcher en el frontend para
disparar `?organization_id` — eso sigue siendo un tema de Fase 3+, tal
como se indicó explícitamente ("No hace falta construir UI/org switcher
todavía"). Lo que cambió es que el backend ya nunca resuelve una
ambigüedad por sí solo: o hay una sola respuesta posible, o exige que el
caller la especifique y la verifica contra la realidad.

Con los 4 usuarios bootstrap, el caso de múltiples memberships ni siquiera
se activa todavía: cada uno tiene exactamente una Membership (en
`smartpr-interno-legacy`), así que siempre caen en la rama "1 elegible" —
pero toda la lógica de selección está implementada y testeada para cuando
deje de ser así.

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

**Esta sección refleja el estado tras la revisión PASS_WITH_FIXES** (la
enumeración original quedó obsoleta porque `resolveAppContext` cambió de
contrato — de `AppContext | null` a `ContextResolution` — y varios tests
se reescribieron en vez de solo agregarse).

**`services/context.test.ts` (13 tests, resolver/deps inyectados, sin
Firestore):**
1. Un elegible → `ok` con el contexto correcto.
2. Cero memberships → `no_membership`.
3. Membership inactiva → `no_membership`.
4. **Dos memberships activas, sin selección → `selection_required`**
   (nunca elige arbitrariamente) — reemplaza el test anterior que
   afirmaba lo contrario.
5. Selección de una organización a la que sí pertenece → `ok` con esa
   organización.
6. Selección de una organización a la que NO pertenece → `forbidden_organization`.
7. Selección que coincide con su única membership, pero inactiva →
   `no_membership` (0 elegibles en total).
8. Selección de una membership inactiva teniendo otra elegible activa →
   `forbidden_organization` (nunca cae de vuelta a la otra).
9. Tres memberships activas sin selección → sigue sin romperse, sigue
   exigiendo selección.
10. `AppUser` inactivo, con Membership activa → `no_membership`.
11. Sin registro `AppUser` → `no_membership`.
12. Membership activa cuya `Organization` está inactiva → excluida
    (`no_membership` si era la única).
13. Dos memberships, una con Organization inactiva y otra con Organization
    activa → resuelve automáticamente la activa (no es ambiguo: solo hay
    una elegible).

**`middleware/context.test.ts` (9 tests, resolver inyectado, sin Express
real):**
1. `req.auth` ausente → 401, resolver ni se llama.
2. `no_membership` → 403.
3. `selection_required` → **409** con `organization_ids` en el body,
   `next()` no se llama.
4. `forbidden_organization` → 403.
5. `ok` → `req.appContext` seteado, `next()` llamado.
6. Lee `?organization_id` de la query y lo pasa al resolver como
   selección.
7. **Resolver que rechaza (Firestore caído) → 503, `next()` nunca se
   llama** (el fix principal de este round).
8. Resolver que lanza síncronamente → mismo resultado (503, sin `next()`).
9. El mensaje de error devuelto al cliente nunca incluye el texto crudo
   del error interno.

**`routes.test.ts` → `describe("GET /me ...")` (13 tests, integración con
`supertest`; `repositories/memberships.js`, `users.js` y
`organizations.js` mockeados):**
1. Sin token → 401.
2. Sin Membership → 403.
3. Única Membership inactiva → 403.
4. Un elegible → 200 con `organizationId`/`role` exactos.
5. `organization_id`/`role` en el body del request → ignorados por
   completo.
6. **Varias memberships, sin `?organization_id` → 409**, con
   `organization_ids` correctos en el body.
7. Varias memberships, `?organization_id` de una que sí pertenece → 200
   con esa organización.
8. `?organization_id` de una que NO pertenece → 403.
9. `AppUser` inactivo → 403.
10. `Organization` de la membership inactiva → 403.
11. Fallo del repositorio de memberships → **503**.

**`repositories/membershipId.test.ts` (5 tests, nuevo):**
1. No colisiona cuando el separador aparece dentro de un componente (el
   caso concreto que rompía la versión anterior).
2. No colisiona en una batería de pares adversariales con `::` embebido.
3. Es determinístico (mismo par → mismo id siempre).
4. **Es compatible hacia atrás:** para los ids reales ya escritos
   (uid de Firebase + slug de organización), produce el mismo string que
   la versión anterior — no hizo falta migrar Firestore.
5. Nunca produce un `/` (el único carácter que Firestore prohíbe en un id
   de documento).

---

## TEST_RESULTS

```
$ npm test
> npm run test --workspace=backend && npm run test --workspace=frontend

backend:  Test Files  6 passed (6) | Tests  55 passed (55)
frontend: Test Files  1 passed (1) | Tests   4 passed (4)
```

(55 backend = 17 de Fase 1 + 38 de Fase 2, tras el round de fixes —
reemplaza el conteo original de 31/14, que correspondía al contrato
anterior de `resolveAppContext`.)

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
- **RESUELTO (revisión PASS_WITH_FIXES):** ~~la estrategia de selección
  multi-membership elegía una arbitrariamente~~. Ya no: `resolveAppContext`
  nunca elige por sí solo con 2+ memberships elegibles — exige
  `?organization_id` explícito y lo verifica contra las memberships reales
  del usuario (ver `MULTI_MEMBERSHIP_SELECTION` arriba). Lo que sigue
  faltando (y sigue siendo Fase 3+) es la UI/endpoint para que el frontend
  sepa que debe ofrecer esa selección al usuario cuando `GET /me` responda
  409.
- **RESUELTO (revisión PASS_WITH_FIXES):** ~~no se valida
  `Organization.status`~~. Ya se valida: un contexto válido requiere
  `AppUser` activo + `Membership` activa + `Organization` activa, las tres
  a la vez (ver `MEMBERSHIP_RESOLUTION` arriba y
  `AUTHORIZATION_SEMANTICS` en `services/context.ts`).
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

- [ ] **Recibir el PASS final** de esta revisión (round `PASS_WITH_FIXES`
      ya aplicado — ver `PHASE_02_FIXES_ADDENDUM` al final de este
      documento).
- [ ] Fase 3: tenant isolation real — aplicar `requireMembership` (+
      chequeo de rol/ownership) a `/session/start`, `/session/end`,
      `/metrics/analyze` y, sobre todo, cerrar el P0 de
      `/admin/sessions`.
- [ ] Fase 3: construir la UI/endpoint de frontend que dispare
      `?organization_id` cuando `GET /me` responda 409
      (`selection_required`) — el backend ya nunca elige arbitrariamente,
      pero no hay todavía ningún "org switcher" que use esa selección.
- [x] ~~Fase 3: evaluar si conviene chequear `Organization.status`~~ —
      **resuelto en el round `PASS_WITH_FIXES`**, ya no es Fase 3.
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
3. **RESUELTO (era el punto más frágil, corregido en el round
   `PASS_WITH_FIXES`):** la selección multi-membership ya no elige
   arbitrariamente — con 2+ organizaciones elegibles exige
   `?organization_id` explícito y lo verifica contra las memberships
   reales. Lo que Fase 3 sigue debiendo construir es la parte de UI/UX:
   ningún frontend sabe todavía qué hacer con un 409
   `selection_required` (org switcher, recordar la última organización
   elegida, etc.) — el contrato backend ya es correcto y estable para que
   Fase 3 construya eso encima.
4. **RESUELTO:** `Organization.status` ya bloquea — un contexto válido
   exige `AppUser` activo + `Membership` activa + `Organization` activa,
   las tres. Fase 3 puede asumir esto como ya garantizado por
   `resolveAppContext`, no como algo pendiente de agregar.
5. **El nuevo código de estado (`ContextResolution` con 4 variantes, y el
   503 de `requireMembership` ante fallos del resolver) es el patrón que
   Fase 3 debería replicar** para cualquier autorización nueva por
   endpoint: nunca devolver `null`/booleano plano para "no autorizado" —
   distinguir explícitamente por qué, y manejar el caso de que la
   dependencia (Firestore) falle, en vez de dejar que la excepción se
   propague sin control.

---

## PHASE_02_FIXES_ADDENDUM (round `PASS_WITH_FIXES`)

Este addendum documenta, sin reescribir el resto del reporte por completo,
los 4 fixes exactos pedidos por la revisión y aplicados sobre el commit
original `bf4036d2fb2cb804a96c42578d07e5626d5b948a`:

1. **Eliminada la estrategia "oldest active Membership wins".** Reemplazada
   por el contrato `ContextResolution` (`ok` / `no_membership` /
   `selection_required` / `forbidden_organization`) descrito en
   `MEMBERSHIP_RESOLUTION` y `MULTI_MEMBERSHIP_SELECTION` arriba. Un
   `organizationId` solicitado por el cliente es una selección entre sus
   propias memberships (verificada server-side), nunca una autoridad.
2. **`requireMembership` ahora captura fallos del resolver.** `try/catch`
   alrededor de `resolve(...)`; ante una excepción, loguea internamente,
   responde **503** genérico (nunca el mensaje/stack real) y nunca llama
   a `next()`. Antes, una excepción del resolver se propagaba sin control.
3. **`membershipId()` corregido para ser libre de colisiones.** Cada
   componente se codifica con `encodeURIComponent` antes de unirlo con
   `::`, así que el separador nunca puede aparecer dentro de un
   componente codificado — la colisión es estructuralmente imposible, no
   solo improbable. Compatible hacia atrás con los ids ya escritos (ver
   `FIRESTORE_SCHEMA` arriba).
4. **Semántica de `status` definida y aplicada, no solo documentada.**
   `resolveAppContext` ahora exige `AppUser.status === "active"` +
   `Membership.status === "active"` + `Organization.status === "active"`
   para considerar un contexto válido — las tres, no solo la Membership
   como antes.

Documentación actualizada como parte de este addendum: `START_HERE.md`
(deja de afirmar que Fase 2 está "aprobada por revisión técnica" hasta
recibir el PASS final), el contrato de `GET /me` en `routes.ts`, y las
secciones `FIRESTORE_SCHEMA`, `MEMBERSHIP_RESOLUTION`,
`AGENCY_ADMIN_MODEL`, `KNOWN_LIMITATIONS`, `TESTS_ADDED`, `TEST_RESULTS`,
`OPEN_ITEMS` y esta misma sección de este reporte.

Tests nuevos/reescritos: `services/context.test.ts` (13),
`middleware/context.test.ts` (9), `routes.test.ts` → `GET /me` (11 en el
nuevo contrato), `repositories/membershipId.test.ts` (5, nuevo). Total
backend: **55 tests** (antes 31). `npm test` y `npm run build` verdes —
ver `TEST_RESULTS` arriba.

No se desplegó nada. No se avanzó a Fase 3.

**Commit de código original de esta fase:** `bf4036d2fb2cb804a96c42578d07e5626d5b948a`
**Commit de los fixes de este addendum:** `5a34b26356630774ce616d8155e1eac14d503fe2`
**Este reporte:** commiteado por separado, después del código de los fixes.
