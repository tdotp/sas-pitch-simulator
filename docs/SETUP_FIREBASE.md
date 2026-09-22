# Configuración Firebase — paso a paso

Firebase se usa para **persistencia** (Organization/User/Membership/sesiones, transcripts, métricas, scores) y para **autenticación real** (Firebase Auth, email/password). La persistencia sigue **fuera del camino crítico** de la conversación en cuanto a resultados: si Firestore no está listo, la app funciona igual (con `PERSISTENCE_DISABLED=true` o sin service account, loguea en consola) — pero la autenticación y la autorización SÍ dependen de Firestore (Membership), así que sin él nadie puede usar ninguna ruta sensible. La autenticación es obligatoria: sin `VITE_FIREBASE_*` configuradas en el frontend, nadie puede entrar; sin un Firestore accesible, nadie puede pasar de "autenticado" a "autorizado" (ver Fase 3 abajo).

> **Ya NO hay login hardcodeado.** El login usa Firebase Auth (email/password)
> y el backend verifica un ID token real en cada request sensible (Fase 1),
> y además exige una Membership activa en una Organization activa (Fase
> 2/3) — ya no hay ninguna allowlist de correos en código ni en `.env`. Ver
> `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md`,
> `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md` y
> `PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md`.

## 1. Crear proyecto

1. https://console.firebase.google.com → **Agregar proyecto**.
2. Nombre: `SAS Pitch Simulator`.
3. Analytics: opcional.

## 2. Crear Firestore

1. **Build → Firestore Database → Crear base de datos**.
2. Modo: **Producción**.
3. Ubicación: `us-central1` (o `nam5`).

### Reglas Firestore (MVP)

Como el backend escribe con Admin SDK (bypassa reglas) y el frontend no lee Firestore directamente todavía, deja lectura/escritura cerrada al público:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false; // solo el backend (Admin SDK) accede
    }
  }
}
```

## 3. Service account (para el backend)

1. **Configuración del proyecto (⚙️) → Cuentas de servicio**.
2. **Generar nueva clave privada** → descarga el JSON.
3. Guárdalo FUERA de git, por ejemplo en `backend/secrets/serviceAccount.json`.
   (La carpeta `secrets/` y los `serviceAccount*.json` ya están en `.gitignore`.)
4. En `backend/.env`:
   ```
   FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/serviceAccount.json
   FIREBASE_PROJECT_ID=tu-project-id
   FIREBASE_STORAGE_BUCKET=tu-project-id.appspot.com   # si usarás Storage
   PERSISTENCE_DISABLED=false
   ```

## 4. Config web para el frontend (obligatoria desde Fase 1)

Necesaria para que el login (Firebase Auth) funcione.

1. **Configuración del proyecto → Tus apps → Web (</>)** → registrar app.
   Ya está creada para este proyecto (`SAS Pitch Simulator Web`).
2. Copia el objeto config a `frontend/.env` (variables `VITE_FIREBASE_*`).
   Es información pública — la misma que ve cualquier navegador que cargue
   la app —, así que va en el `.env` versionado, no en uno local.
3. En **Authentication → Sign-in method**, el proveedor **Email/Password**
   debe estar habilitado.
4. Los usuarios se crean con el Admin SDK (backend, `firebase-admin`), no
   desde el frontend — no hay registro público. Cada persona recibe un
   enlace de restablecimiento de contraseña para definir la suya la primera
   vez.
5. Eso solo los autentica. Para que puedan usar la app hace falta además
   una Membership (ver sección siguiente) — sin eso, un login válido
   igual da 403.

## 5. Acceso real: Organization + Membership (Fase 2/3, reemplaza la allowlist de Fase 1)

Cualquiera con la `apiKey` pública del frontend puede **auto-registrarse**
en Firebase Auth (es como funciona el proveedor email/password). Un token
válido por sí solo NO implica que esa persona deba tener acceso — por eso
un usuario recién autenticado, sin más, siempre recibe 403 en cualquier
ruta sensible. El acceso real lo da tener una **Membership activa** en una
**Organization activa**, en Firestore (colecciones `organizations`,
`users`, `memberships` — ver `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md`
para el modelo completo). Para dar de alta a alguien:

```
npm run bootstrap:phase2-legacy-org --workspace=backend
```

(o el patrón de ese script — `upsertOrganization` / `upsertUser` /
`upsertMembership` desde `backend/src/repositories/`) — nunca una variable
de entorno. La antigua `AUTH_ALLOWED_EMAILS` se retiró en Fase 3
precisamente porque duplicaba este control con un sistema paralelo.

## 6. Verificar

Con el backend corriendo deberías ver en el log:

```
[firebase] Firebase Admin inicializado (Auth disponible).
[firebase] Firestore listo. Persistencia activa.
```

Y tras una práctica, un documento nuevo en la colección **`sessions`** con: `organization_id`, `target_mode`, `duration_seconds`, `transcript`, `metrics`, `evaluation`.

## Modelo de datos (colección `sessions`)

```jsonc
{
  "session_id": "uuid",
  "user_id": "<firebase uid, verificado server-side>",
  "user_name": "<email del usuario autenticado>",
  "organization_id": "<de req.appContext, nunca del cliente — Fase 3>",
  "target_mode": "generic | davivienda | grupo_aval",
  "voice_gender": "male | female | random",
  "status": "in_progress | completed",
  "started_at": "ISO", "ended_at": "ISO",
  "duration_seconds": 97,
  "transcript": { "full": "...", "user_only": "...", "agent_only": "..." },
  "metrics": { "word_count": 0, "words_per_minute": 0, "filler_words_total": 0, "...": "..." },
  "evaluation": { "overall_score": 82, "readiness_level": "alto", "criteria_scores": [], "...": "..." }
}
```
