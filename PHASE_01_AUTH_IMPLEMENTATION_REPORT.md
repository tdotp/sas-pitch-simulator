# PHASE_01_AUTH_IMPLEMENTATION_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 1 de 15 — Autenticación real y base de identidad
**Fecha:** 22 de septiembre de 2026
**Código commit:** `392383c` (rama `master`)
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado.**

---

## WHAT_CHANGED

Se reemplazó el gate de login hardcoded (`APP_USERS` en
`frontend/src/config.ts`, validado solo en el navegador) por autenticación
real de extremo a extremo:

```
usuario -> Firebase Auth (email/password)
        -> ID token (JWT firmado por Google)
        -> backend verifica el token con Firebase Admin
        -> backend deriva uid/email verificados
        -> backend exige que el email esté en una allowlist temporal
        -> backend conoce la identidad real del usuario
```

El frontend dejó de ser la autoridad sobre identidad. El backend ahora
verifica cada request sensible de forma independiente, sin confiar en nada
que el cliente afirme sobre quién es.

No se tocó: Firestore (sigue siendo la única base de datos), la
arquitectura de voz (navegador ↔ ElevenLabs directo, sin pasar por el
backend), ni ningún concepto de Organization/Membership/roles (eso es
Fase 2). No se introdujo Postgres, Redis, ni lógica específica de ningún
cliente.

---

## FILES_CHANGED

**Backend**
- `backend/src/middleware/auth.ts` (nuevo) — middleware `requireAuth`,
  verificador de ID token inyectable (`createRequireAuth`) para poder
  testear sin Firebase real.
- `backend/src/routes.ts` — `requireAuth` en `/session/start`,
  `/session/end`, `/metrics/analyze`, `/admin/sessions`. `/session/start`
  deriva `user_id`/`user_name` del token, no del body. `/session/end`
  agrega un chequeo de ownership contra el `Map` en memoria existente.
- `backend/src/config.ts` — `authAllowedEmails` (lee `AUTH_ALLOWED_EMAILS`).
- `backend/src/types.ts` — `SessionRecord.owner_uid` (opcional, solo en el
  `Map` en memoria).
- `backend/.env.example`, `backend/.env` (no versionado) —
  `AUTH_ALLOWED_EMAILS`.
- `backend/src/middleware/auth.test.ts`, `backend/src/routes.test.ts`
  (nuevos) — 14 tests.
- `backend/vitest.config.ts` (nuevo), `backend/tsconfig.json` (excluye
  `*.test.ts` del build), `backend/package.json` (script `test`,
  dependencias `vitest`/`supertest`/`@types/supertest`).

**Frontend**
- `frontend/src/firebase.ts` (nuevo) — bootstrap del SDK web de Firebase.
- `frontend/src/auth.tsx` (nuevo) — `AuthProvider`/`useAuth`: login, logout,
  reset de contraseña, restauración de sesión, `getIdToken`.
- `frontend/src/components/Login.tsx` — reescrito sobre `useAuth`, mismo
  diseño visual, sin `onLogin` prop.
- `frontend/src/components/ScenarioSelect.tsx` — botón "Cerrar sesión".
- `frontend/src/api.ts` — adjunta `Authorization: Bearer`, reintento único
  con `forceRefresh` ante 401, nunca ante 403. `startSession` ya no acepta
  `user_id`/`user_name`.
- `frontend/src/App.tsx` — gate de auth basado en `useAuth().user`/`loading`
  en vez de un stage `"login"` manual.
- `frontend/src/main.tsx` — envuelve la app en `<AuthProvider>`.
- `frontend/src/config.ts` — se elimina `APP_USERS`.
- `frontend/.env` — variables públicas `VITE_FIREBASE_*`.
- `frontend/src/api.test.ts` (nuevo) — 4 tests.
- `frontend/vitest.config.ts` (nuevo), `frontend/package.json` (script
  `test`, dependencia `vitest`).

**Raíz / docs**
- `package.json` — script `test` (corre ambos workspaces).
- `START_HERE.md`, `HANDOFF.md`, `docs/SETUP_FIREBASE.md` — actualizados
  para reflejar el nuevo auth real y marcar qué P0 sigue abierto.
- `ACCESOS.md` (gitignored, no en este commit) — actualizado para
  reflejar que las contraseñas fijas antiguas ya no aplican.

---

## AUTH_FLOW_BEFORE

```
Login.tsx compara (user, pass) contra APP_USERS en config.ts
  -> si coincide, onLogin() cambia el stage local a "select"
  -> no hay token, no hay sesión, no hay verificación de servidor

/session/start recibe { user_id, user_name } en el body
  -> los usa tal cual para el SessionRecord (default: "sandra_hernandez")
  -> cualquiera que conozca la URL del backend puede llamarlo con
     cualquier user_id/user_name arbitrario

/admin/sessions no pide ninguna credencial
```

Riesgo real: las 4 contraseñas vivían en texto plano en
`frontend/src/config.ts`, visibles en el bundle JS público — y ese
archivo llegó a estar en un repo de GitHub que estuvo **público**
brevemente durante una revisión externa (ver `git log`). Deben
considerarse expuestas.

---

## AUTH_FLOW_AFTER

```
Login.tsx llama signInWithEmailAndPassword(auth, email, password)
  -> Firebase Auth valida contra su propio directorio de usuarios
  -> onAuthStateChanged (en AuthProvider) actualiza el estado global
  -> App.tsx reacciona a auth.user: no autenticado => <Login/>,
     autenticado => la app normal

Cada llamada sensible a /api/*:
  api.ts obtiene user.getIdToken() y lo manda como
  "Authorization: Bearer <idToken>"

Backend (requireAuth, en cada ruta sensible):
  1. ¿Hay header Authorization con formato "Bearer <token>"?
     No -> 401
  2. admin.auth().verifyIdToken(idToken)
     Falla (inválido/expirado) -> 401
  3. ¿decoded.email está en AUTH_ALLOWED_EMAILS (case-insensitive)?
     No -> 403
  4. req.auth = { uid, email } ; next()
```

`x-app-token` (el token compartido anti-abuso) se mantiene sin cambios,
en paralelo — sigue siendo anti-abuso, nunca autenticación.

---

## BACKEND_VERIFICATION

- `backend/src/middleware/auth.ts`: `createRequireAuth(verifyIdToken)`
  construye el middleware con un verificador inyectable; `requireAuth`
  (exportado) usa `admin.auth().verifyIdToken` como verificador real en
  producción.
- Validación de formato del header antes de intentar verificar nada
  (evita llamadas innecesarias a Firebase con basura).
- El error de `verifyIdToken` (token inválido, expirado, mal firmado) se
  captura y siempre responde 401 genérico — no filtra el motivo exacto al
  cliente.
- El email se compara en minúsculas contra la allowlist, también en
  minúsculas.

---

## FRONTEND_AUTH

- `AuthProvider` se suscribe a `onAuthStateChanged` una vez al montar la
  app; expone `{ user, loading, login, logout, resetPassword, getIdToken }`.
- `loading` es `true` hasta que Firebase resuelve el estado inicial
  (localStorage/IndexedDB) — `App.tsx` muestra una pantalla neutra mientras
  tanto para no parpadear el login.
- `Login.tsx` ofrece exactamente tres acciones: iniciar sesión, y
  "¿Olvidaste tu contraseña?" (que llama `sendPasswordResetEmail`). **No
  hay ninguna acción de registro/signup en el frontend**, tal como se pidió.
- `ScenarioSelect.tsx` agrega "Cerrar sesión" (`signOut`), la única
  adición de UI fuera de Login — no es un rediseño, es el mínimo necesario
  para que Logout exista en algún lugar alcanzable.

---

## SESSION_IDENTITY_CHANGES

- `/session/start`: `user_id: auth.uid`, `user_name: auth.email ?? auth.uid`.
  El body puede seguir enviando `user_id`/`user_name` (el tipo
  `StartSessionRequest` no cambió), pero el handler los ignora por
  completo — ver test `ignores a client-supplied user_id...` en
  `routes.test.ts`.
- `/session/end` — **ownership check temporal, no durable**: si el
  `session_id` sigue en el `Map` en memoria (mismo proceso, no reiniciado),
  solo el `uid` que hizo el `/session/start` puede terminarlo (403 si no
  coincide). Si el proceso se reinició o el `Map` ya no tiene el registro
  (`stored` es `undefined`), el chequeo se salta — exactamente el mismo
  comportamiento no-durable que tenía el resto de la lógica de
  `/session/end` antes de esta fase. **Esto no es la solución real de
  ownership** (esa llega con estado durable en Firestore en la Fase 4) —
  es una mitigación mínima sobre la estructura que ya existía, tal como se
  pidió explícitamente. No se refactorizó el session lifecycle.

---

## TESTS_ADDED

**Backend (`backend/src/middleware/auth.test.ts` — unitario, sin Express;
`backend/src/routes.test.ts` — integración con `supertest`, providers
externos mockeados):**

1. Sin `Authorization` → 401
2. `Authorization` mal formado (no `Bearer ...`) → 401
3. `verifyIdToken` rechaza (token inválido/expirado) → 401
4. Token válido, email fuera de la allowlist → 403
5. Token válido, sin email → 403
6. Token válido y permitido → continúa (`next()`, `req.auth` seteado)
7. Match de allowlist case-insensitive
8. `POST /session/start` sin token → 401
9. `POST /session/start` con token inválido → 401
10. `POST /session/start` con token válido no permitido → 403
11. `POST /session/start` con token válido permitido → 200
12. `GET /admin/sessions` sin token → 401
13. `/session/start` **ignora** `user_id` del body y `/session/end`
    **rechaza** (403) a un uid distinto del que inició la sesión, incluso
    cuando el body intentó suplantar esa identidad
14. `/session/end` con el uid real que inició la sesión → 200

**Frontend (`frontend/src/api.test.ts`):**

1. Cada llamada adjunta el ID token actual como `Authorization: Bearer`
2. Un 401 dispara exactamente un reintento con `getIdToken(true)`
   (force-refresh)
3. Si el reintento también da 401, no hay un tercer intento — falla
4. Un 403 **nunca** dispara un reintento ni un refresh de token

---

## TEST_RESULTS

```
$ npm test
> npm run test --workspace=backend && npm run test --workspace=frontend

backend:  Test Files  2 passed (2) | Tests  14 passed (14)
frontend: Test Files  1 passed (1) | Tests   4 passed (4)
```

```
$ npm run build
backend:  tsc -p tsconfig.json                    -> sin errores
frontend: tsc -b && vite build                     -> sin errores
          (warning preexistente de tamaño de chunk >500kB, no relacionado
          con esta fase — el bundle ya incluía @elevenlabs/react y ahora
          además firebase/auth)
```

Todo corrido y confirmado localmente el 22-sep-2026, contra el commit
`392383c`.

---

## KNOWN_LIMITATIONS

- **`GET /admin/sessions` — `OPEN_P0`.** Requiere login válido y permitido,
  pero **no hay roles**. Cualquier usuario en `AUTH_ALLOWED_EMAILS` puede
  leer todas las sesiones de todos (transcripts completos, scores). Esto
  es exactamente lo que el prompt de esta fase pidió dejar así — RBAC real
  llega en Fases 2–3 (Organization/Membership). **No se debe marcar como
  resuelto.**
- **Ownership de `/session/end` no es durable.** Depende del mismo `Map`
  en memoria que ya existía (se pierde al reiniciar el proceso, no
  funciona con más de una instancia del backend). Es una protección
  temporal explícitamente aceptada para esta fase, no el diseño final. La
  solución durable es Fase 4 (session lifecycle en Firestore).
- **Auto-registro a nivel de proveedor.** Firebase Auth con
  email/password permite que cualquiera con la `apiKey` pública (que va en
  el bundle JS, como en cualquier app web) cree una cuenta nueva. La
  allowlist server-side (`AUTH_ALLOWED_EMAILS`) es lo que impide que esa
  cuenta tenga acceso real — sin ella, un token válido habría bastado. Si
  algún día se agrega `createUserWithEmailAndPassword` en el frontend (no
  se hizo en esta fase), hay que revisar esta mitigación de nuevo.
- **La allowlist es una lista plana en una env var**, no un modelo de
  datos. Agregar o quitar una persona requiere editar `backend/.env` y
  reiniciar/redeployar el backend. Aceptable para 4 usuarios; no escala
  más allá de eso — la Fase 2 lo reemplaza.
- **No hay verificación de email obligatoria** (`emailVerified`) como
  condición de acceso — los 4 usuarios bootstrap se crearon con
  `emailVerified: true` directamente vía Admin SDK, así que esto no bloquea
  el flujo actual, pero si se agregan cuentas nuevas por otro medio, esto
  no se está chequeando en el middleware.
- **`x-app-token` sigue siendo anti-abuso, no autenticación** — sin
  cambios, tal como se pidió.

---

## MIGRATION_NOTES

Para que esta fase funcione en un entorno (local o VPS), además del código:

1. **Firebase Auth → Email/Password** debe estar habilitado en el
   proyecto (`smartpr-pitch-agent`). Se verificó con la API de Identity
   Toolkit que ya estaba habilitado — no se tocó nada ahí.
2. **App web de Firebase**: se creó una nueva
   (`SAS Pitch Simulator Web`, App ID
   `1:404202423066:web:cd6bd60af169b170bc22a3`) dentro del **mismo**
   proyecto Firebase existente. No se creó ni se tocó ningún otro
   proyecto.
3. **4 usuarios creados en Firebase Auth vía Admin SDK** (script one-shot,
   no versionado, borrado tras usarlo — no dejó nada en git):
   `gerardo.calambas@smartpr.com.co`, `daniel.espana@smartpr.com.co`,
   `fabian.motta@smartpr.com.co`, `juan.motta@smartpr.com.co`. Dos ya
   existían (de un intento previo), dos se crearon en esta corrida. Para
   cada uno se generó un enlace de restablecimiento de contraseña de un
   solo uso con `generatePasswordResetLink` — **esos enlaces no se
   guardaron en ningún archivo, log, commit ni documento; se entregaron
   directamente por chat al dueño del proyecto** para que los reenvíe. Si
   se pierden, se regeneran desde Firebase Console o con el mismo método
   del Admin SDK.
4. **Variables de entorno nuevas que hay que llevar al VPS al desplegar**
   (no están ahí todavía, porque no se ha desplegado):
   - `backend/.env`: `AUTH_ALLOWED_EMAILS=<los 4 correos, separados por
     coma>`.
   - `frontend/.env` ya tiene los `VITE_FIREBASE_*` (son públicos y van
     versionados, así que viajan solos con el build).
5. **No se desplegó nada** (ni `firebase deploy`, ni redeploy del VPS).
   Producción sigue corriendo el código anterior (login hardcoded) hasta
   que se apruebe esta fase y se despliegue explícitamente.

---

## SECURITY_NOTES

- Las 4 contraseñas hardcoded que existían antes (`memobox1810`,
  `123456`×3) **deben considerarse comprometidas** — vivieron en
  `frontend/src/config.ts`, que estuvo en un repo de GitHub que fue
  **público brevemente** durante una revisión externa de este mismo
  proyecto. Ese código ya no existe en el HEAD actual, pero sigue en el
  historial de git. Nadie debe seguir usando `memobox1810` en ningún otro
  sistema.
- El orden de verificación implementado (`Bearer` → `verifyIdToken` →
  `uid/email` → `allowlist`) es el que se pidió explícitamente y es el
  orden correcto: nunca se confía en un claim antes de que la firma del
  token esté verificada.
- Un 403 nunca provoca un refresh de token en el frontend — evita un loop
  inútil de llamadas a Firebase para una persona que simplemente no tiene
  acceso, y evita filtrar (por timing o reintentos) que el sistema "casi"
  la dejó entrar.
- `/admin/sessions` queda como el hueco de seguridad más importante que
  sigue abierto tras esta fase — ver KNOWN_LIMITATIONS. Se documenta pero
  deliberadamente no se resuelve aquí, tal como se indicó.

---

## OPEN_ITEMS

- [ ] Revisar y aprobar este reporte.
- [ ] Decidir cuándo desplegar Fase 1 a producción (frontend + backend).
- [ ] Confirmar que las 4 personas recibieron su enlace de restablecimiento
      y pudieron definir su contraseña.
- [ ] Fase 2: `Organization` + `Membership` + roles (reemplaza la
      allowlist plana y cierra el P0 de `/admin/sessions`).
- [ ] Fase 4: estado durable de sesión (reemplaza el `Map` en memoria y su
      ownership check temporal).

---

**Commit de código de esta fase:** `392383c`
**Este reporte:** commiteado por separado, después del código (ver
`git log` para su SHA — no puede autorreferenciarse).
