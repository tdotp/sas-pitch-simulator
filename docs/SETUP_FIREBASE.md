# Configuración Firebase — paso a paso

Firebase se usa para **persistencia** (sesiones, transcripts, métricas, scores). Está **fuera del camino crítico** de la conversación: si no está listo, la app funciona igual (con `PERSISTENCE_DISABLED=true` o sin service account, loguea en consola).

Para el MVP el login es **hardcodeado** en el frontend (no usamos Firebase Auth todavía), así que solo necesitas Firestore + un service account para el backend.

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

## 4. (Opcional) Config web para el frontend

Solo necesaria si más adelante el frontend lee Firestore o usa Firebase Auth. Config pública:

1. **Configuración del proyecto → Tus apps → Web (</>)** → registrar app.
2. Copia el objeto config a `frontend/.env.local` (variables `VITE_FIREBASE_*`).

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
  "user_id": "sandra_hernandez",
  "user_name": "Sandra Hernández",
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
