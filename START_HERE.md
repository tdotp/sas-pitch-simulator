# START HERE — SAS Pitch Simulator

Pega este archivo (o dile al nuevo chat que lo lea) y podrá continuar sin leer
el resto de la documentación. Última actualización: 22 de septiembre de 2026
(Fase 2 cerrada).

## 1. Qué es

Simulador de vocería ejecutiva por voz para SAS Colombia (SmartPR). La persona
practica un pitch hablando con un interlocutor C-level simulado y recibe un
reporte de evaluación con IA. 3 escenarios: **genérico, Davivienda, Grupo Aval**.

Repo local: `/Users/gerardocalambasposada/Documents/Claude_/SAS` (monorepo npm
workspaces: `backend/`, `frontend/`). Remoto: `tdotp/sas-pitch-simulator` en
GitHub — **actualmente PÚBLICO** (a pedido explícito, para que una revisión
externa vaya comparando avances; volver a ponerlo privado cuando esa
revisión termine). Contiene correos y prompts propios de SAS mientras
esté público.

## 2. Estado (verificado el 22-sep-2026)

- **Fase 1 (auth real, Firebase Auth): CERRADA, aprobada por revisión
  técnica.** Ver `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md`.
- **Fase 2 (Organization + Membership + Role): implementada, en revisión
  técnica — recibió `PASS_WITH_FIXES` y los fixes ya se aplicaron; a la
  espera del PASS final, todavía NO se declara cerrada.** No desplegar
  hasta recibirlo. Ver `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md`.
- Ninguna de las dos fases está desplegada todavía.
- Producción sigue corriendo la versión **anterior** (login hardcoded, sin
  auth real, sin Organization/Membership) hasta que se aprueben y
  desplieguen estas fases:
  - Frontend: https://smartpr-pitch-agent.web.app (Firebase Hosting)
  - Backend: https://185-215-180-182.nip.io (VPS, Docker + Caddy, HTTPS vía nip.io)
- El código de Fase 1 pasa build y tests localmente (backend + frontend),
  pero **no se ha hecho `firebase deploy` ni redeploy del VPS** con estos
  cambios — desplegar sin antes crear/avisar a los usuarios los dejaría
  fuera.
- Firestore: 68 sesiones de prueba (16 completas, 51 abandonadas), de antes
  de esta fase.

## 3. Arquitectura en 6 líneas

```
Navegador ─► Firebase Hosting (React + Vite, estático)
   ├─► ElevenLabs (WebSocket DIRECTO: STT + LLM del entrevistador + TTS)
   └─► Backend Express (VPS, Docker, tras Caddy)
          ├─► OpenRouter → Claude Sonnet 4 (evalúa el pitch al terminar)
          └─► Firestore (colección `sessions`)
```

El backend NO está en la ruta de la voz en vivo: solo arma el prompt + pide la
signed URL al inicio (`POST /session/start`) y evalúa al final (`POST /session/end`).

## 4. Dónde vive cada cosa (archivos clave)

| Qué | Archivo |
|---|---|
| Prompts del entrevistador (3 escenarios, flujo de 2 repreguntas) | `backend/src/data/prompts.ts` |
| Rúbricas de evaluación | `backend/src/data/rubrics.ts` |
| Perfiles de cliente / playbook SAS | `backend/src/data/profiles.ts`, `playbook.ts` |
| Prompt del evaluador (Claude) | `backend/src/data/evaluatorPrompt.ts` |
| Métricas de habla (regex, sin LLM) | `backend/src/services/metrics.ts` |
| ElevenLabs (signed URL, voces) | `backend/src/services/elevenlabs.ts` |
| Rutas + token compartido + rate limit | `backend/src/routes.ts` |
| Firestore | `backend/src/firebase.ts` |
| Máquina de estados de la app (7 pantallas) | `frontend/src/App.tsx` |
| Lógica de conversación (turnos, cierre por silencio) | `frontend/src/components/PracticeSession.tsx` |
| Usuarios de login + escenarios (UI) | `frontend/src/config.ts` |
| Estilos (desktop + mobile ≤900px) | `frontend/src/styles.css` |
| Docker / proxy | `docker-compose.yml`, `Caddyfile`, `backend/Dockerfile` |

## 5. Decisiones y comportamientos que NO son obvios

- **Auth (desde Fase 1, 22-sep-2026)**: Firebase Auth real (email/password).
  El backend verifica el ID token (`Authorization: Bearer`) y además exige
  que el email esté en `AUTH_ALLOWED_EMAILS` (allowlist temporal — el
  proveedor email/password permite auto-registro, así que un token válido
  por sí solo no basta). Token inválido → 401; token válido pero no
  permitido → 403. El frontend reintenta una sola vez con token refrescado
  ante un 401; nunca reintenta ante un 403. No hay signup en el frontend —
  las cuentas se crean con Admin SDK. `/admin/sessions` sigue siendo un P0
  abierto: cualquier usuario autenticado y permitido puede leer todas las
  sesiones (no hay roles todavía). Detalle completo en
  `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md`.
- **Repreguntas**: exactamente 2. La 1ª textual de una lista fija; la 2ª de la
  misma lista pero anclada a lo que la persona respondió. Lo aplica el prompt (el
  LLM de ElevenLabs), no hay enforcement en código.
- **Cierre de la sesión**: el frontend cuenta los turnos del agente (1=consigna,
  2=repregunta 1, 3=repregunta 2). Al empezar a responder la repregunta 2 arma un
  timer de 3s que se reinicia con cada mensaje nuevo; a los 3s de silencio cierra
  y genera el reporte. Tope absoluto de 10 min como último recurso.
- **Timer 90s/3min**: solo valida el **pitch inicial** (se captura cuando el agente
  empieza la repregunta 1). Ya NO corta la conversación. Esa duración es la que se
  manda al backend para el reporte.
- **Mobile**: layout responsive ya integrado; en la conversación mobile se oculta
  el texto de la pregunta del agente (solo orbe + estado + timer).
- **Paleta**: vino/crema de marca (NO el azul del paquete de diseño de referencia).
- **Login**: Firebase Auth real desde Fase 1 (ver arriba). Ya no es un gate
  de frontend con credenciales hardcoded.
- **VPS compartido** con `n8n` y `aleja-app`: no tocarlos; el backend vive en su
  propia red Docker (`sas-pitch-simulator-net`). Verificar `docker ps` antes/después
  de cualquier cambio.
- **Caché tras deploy**: Firebase/navegador pueden servir el bundle viejo un rato.
  Si algo "no cambió", compara el hash del JS servido vs `frontend/dist` antes de
  asumir un bug.
- **Apagar/prender** (ya se hizo antes, funciona): backend con
  `docker compose stop|start backend` en el VPS; frontend con
  `firebase hosting:disable --force` y se reactiva con `firebase deploy --only hosting`.

## 6. Comandos esenciales

```bash
# Local
npm run dev:backend      # :8080
npm run dev:frontend     # :5173 (proxy /api → :8080)

# Tests + build (correr antes de cualquier deploy)
npm test                 # backend (vitest) + frontend (vitest)
npm run build             # backend (tsc) + frontend (tsc + vite build)

# Deploy frontend
npm run build --workspace=frontend && firebase deploy --only hosting

# Deploy backend (VPS)
rsync -az -e "ssh -i ~/.ssh/id_ed25519_sas" backend/src backend/package.json \
  sasdeploy@185.215.180.182:~/sas-pitch-simulator/backend/
ssh sas-vps 'cd ~/sas-pitch-simulator && docker compose build backend && docker compose up -d backend'

# Salud
curl -s https://185-215-180-182.nip.io/api/health
```

## 7. Accesos

**Las credenciales reales NO están en este archivo.** Están en `ACCESOS.md`
(misma carpeta, gitignored): llaves ElevenLabs/OpenRouter, `.env` completo, acceso
SSH al VPS (`ssh sas-vps`, usuario `sasdeploy`, llave `~/.ssh/id_ed25519_sas`),
Firebase (proyecto `smartpr-pitch-agent`), y el estado de las 4 cuentas de
login de la app (Firebase Auth real desde Fase 1 — ya no son contraseñas
fijas en código).
Si trabajas desde otra máquina, copia esas llaves como archivos (no como texto).

## 8. Riesgos y deuda conocida (resumen del reporte de escalamiento)

Preparación multi-cliente: **LOW** (evaluación previa a Fase 1). Lo crítico (P0):
- No existe el concepto de organización/tenant en ningún lado. **Abierto.**
- ~~No hay autenticación real...~~ **Resuelto en Fase 1** (22-sep-2026):
  Firebase Auth + verificación de ID token server-side + allowlist temporal.
  Ver `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md`.
- `GET /admin/sessions` devuelve sesiones de todos sin control de acceso.
  **Sigue abierto** — ahora exige login válido y permitido, pero no hay
  roles: cualquier usuario allowlisted puede leer todas las sesiones.
  **Sigue abierto tras Fase 2** — `GET /me` resuelve organización/rol pero
  ninguna ruta de recursos lo usa todavía; eso es Fase 3.
- Estado de sesión en un `Map` en memoria del proceso (se pierde al reiniciar).
  **Sigue abierto** — la Fase 1 agregó un chequeo de ownership sobre ese
  mismo `Map` (protección temporal, no durable); la solución real
  (Firestore-backed) es Fase 4.
- ~~No existe el concepto de organización/tenant...~~ **Modelo base
  resuelto en Fase 2** (22-sep-2026): `Organization` + `Membership` + `Role`
  en Firestore, con resolución server-side (`GET /me`). **Tenant isolation
  real (aplicarlo a los endpoints) sigue sin existir — eso es Fase 3.** Ver
  `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md`.

Otros (P1): sin instrumentación de latencia, rate-limit por IP (puede bloquear a
una oficina entera), persistencia fire-and-forget sin reintentos, sin timeouts ni
retries hacia ElevenLabs/OpenRouter, prompts/rúbricas hardcoded (cliente nuevo =
código + deploy).

Recomendación: NO migrar a Postgres (Firestore alcanza). Con Fases 1 y 2 ya
implementadas, el siguiente paso es Fase 3 (tenant isolation real —
aplicar Membership a los endpoints). Estimación original: ~48–74 días-dev
(~12–17 semanas con 1 dev). Detalle completo en
`SPOKESPERSON_TRAINING_SCALING_REPORT.md` y
`PLAN_TRABAJO_ESCALAMIENTO_MULTI_CLIENTE.md`.

## 9. Pendientes sugeridos

1. **Revisar y aprobar `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md`,
   y luego desplegar Fases 1+2** (frontend a Firebase Hosting, backend al
   VPS) — hoy solo están implementadas y testeadas localmente.
2. Probar los 3 escenarios completos (no solo el genérico) con usuarios reales y
   confirmar que el cierre a los 3s de silencio se siente natural en un celular
   con conversación de voz real.
3. Fase 3: aplicar `requireMembership` a `/session/*`,
   `/metrics/analyze` y, sobre todo, cerrar el P0 de `/admin/sessions`.
4. Considerar dominio propio para el backend (hoy `nip.io`).

## 10. Documentos existentes (solo si necesitas más detalle)

`report.md` (avance), `HANDOFF.md` (contexto de sesión previa),
`SPOKESPERSON_TRAINING_SCALING_REPORT.md` (análisis multi-cliente),
`PHASE_01_AUTH_IMPLEMENTATION_REPORT.md` (auth real — 22-sep-2026),
`PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md` (Organization +
Membership + Role — 22-sep-2026), `ACCESOS.md` (credenciales, no versionado),
`git log` (historial con mensajes detallados de cada cambio).
