# Configuración Firebase — paso a paso

Firebase se usa para **persistencia** (sesiones, transcripts, métricas, scores) y, desde la Fase 1 de escalamiento, para **autenticación real** (Firebase Auth, email/password). La persistencia sigue **fuera del camino crítico** de la conversación: si Firestore no está listo, la app funciona igual (con `PERSISTENCE_DISABLED=true` o sin service account, loguea en consola). La autenticación sí es obligatoria: sin `VITE_FIREBASE_*` configuradas en el frontend y sin `AUTH_ALLOWED_EMAILS` en el backend, nadie puede entrar.

> **Ya NO hay login hardcodeado.** Desde la Fase 1, el login usa Firebase Auth
> (email/password) y el backend verifica un ID token real en cada request
> sensible. Ver `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md` para el detalle
> completo del flujo, sus tests y sus límites conocidos.

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
5. En `backend/.env`, define `AUTH_ALLOWED_EMAILS` con los correos exactos
   que pueden entrar (ver sección siguiente).

## 5. Allowlist temporal de acceso (Fase 1, provisional)

Cualquiera con la `apiKey` pública del frontend puede **auto-registrarse**
en Firebase Auth (es como funciona el proveedor email/password). Un token
válido por sí solo NO implica que esa persona deba tener acceso. Por eso el
backend exige además que el email esté en una lista explícita:

```
# backend/.env
AUTH_ALLOWED_EMAILS=correo1@smartpr.com.co,correo2@smartpr.com.co
```

Vacío = nadie tiene acceso (falla cerrado). Esto es temporal: en las Fases
2–3 (Organization/Membership) lo reemplaza un modelo de roles real.

## 5. Verificar

Con el backend corriendo deberías ver en el log:

```
[firebase] Inicializado. Persistencia activa.
```

Y tras una práctica, un documento nuevo en la colección **`sessions`** con: `target_mode`, `duration_seconds`, `transcript`, `metrics`, `evaluation`.

## Modelo de datos (colección `sessions`)

```jsonc
{
  "session_id": "uuid",
  "user_id": "<firebase uid, verificado server-side>",
  "user_name": "<email del usuario autenticado>",
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
