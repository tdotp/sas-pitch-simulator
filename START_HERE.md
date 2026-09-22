# START HERE — SAS Pitch Simulator

Pega este archivo (o dile al nuevo chat que lo lea) y podrá continuar sin leer
el resto de la documentación. Última actualización: 22 de septiembre de 2026
(Fase 5 implementada, pendiente de revisión).

## 1. Qué es

Simulador de vocería ejecutiva por voz para SAS Colombia (SmartPR). La persona
practica un pitch hablando con un interlocutor C-level simulado y recibe un
reporte de evaluación con IA. 3 escenarios: **genérico, Davivienda, Grupo Aval**
(desde Fase 5, son un `scenarioId` resuelto vía config, no un enum hardcodeado
en el motor — ver `PHASE_05_ENGINE_CONFIG_REPORT.md`).

Repo local: `/Users/gerardocalambasposada/Documents/Claude_/SAS` (monorepo npm
workspaces: `backend/`, `frontend/`). Remoto: `tdotp/sas-pitch-simulator` en
GitHub — **actualmente PÚBLICO** (a pedido explícito, para que una revisión
externa vaya comparando avances; volver a ponerlo privado cuando esa
revisión termine). Contiene correos y prompts propios de SAS mientras
esté público.

## 2. Estado (verificado el 22-sep-2026)

- **Fase 1 (auth real, Firebase Auth): CERRADA, aprobada.** Ver
  `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md`.
- **Fase 2 (Organization + Membership + Role): CERRADA, aprobada.** Ver
  `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md`.
- **Fase 3 (tenant isolation + RBAC real): CERRADA, aprobada.** Ver
  `PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md`.
- **Fase 4 (session lifecycle durable): CERRADA, aprobada.** Ver
  `PHASE_04_SESSION_LIFECYCLE_REPORT.md`.
- **Fase 5 (ENGINE vs CONFIG): implementada, testeada, pendiente de
  revisión técnica — todavía NO se declara cerrada.** No desplegar hasta
  recibir el PASS. **Requiere el fix de `backend/Dockerfile` (copia
  `config-packages/` a la imagen) antes de desplegar** — sin él, el
  backend respondería 503 en todo `/session/start`. Ver
  `PHASE_05_ENGINE_CONFIG_REPORT.md`.
- Ninguna fase está desplegada todavía.
- Producción sigue corriendo la versión **original** (login hardcoded, sin
  auth real, sin Organization/Membership, sin tenant isolation, sin
  session lifecycle, con prompts/rúbricas hardcodeados) hasta que se
  apruebe y despliegue todo lo anterior de una vez:
  - Frontend: https://smartpr-pitch-agent.web.app (Firebase Hosting)
  - Backend: https://185-215-180-182.nip.io (VPS, Docker + Caddy, HTTPS vía nip.io)
- El código pasa build y tests localmente (backend + frontend), pero
  **no se ha hecho `firebase deploy` ni redeploy del VPS** con ninguno de
  estos cambios — desplegar sin antes verificar el impacto en los 4
  usuarios reales (todos ya tienen Membership vía el bootstrap de Fase 2)
  es lo primero a hacer después de la aprobación.
- Firestore: 68 sesiones de prueba (16 completas, 51 abandonadas) de antes
  de Fase 2 — son "legacy": sin `organization_id`, así que ninguna ruta
  nueva las expone (ver `PHASE_03...` § `LEGACY_SESSION_POLICY`).

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
| Paquetes de configuración (prompts, rúbricas, perfiles, playbook por escenario) | `backend/config-packages/sas-colombia/v1/**` |
| Schemas + loader + resolver de configuración (Fase 5) | `backend/src/engine-config/{schema,loader,resolver}.ts` |
| Motor genérico de prompts (entrevistador + evaluador) | `backend/src/engine/{promptBuilder,evaluatorPromptBuilder}.ts` |
| Métricas de habla (regex, sin LLM) | `backend/src/services/metrics.ts` |
| ElevenLabs (signed URL, voces) | `backend/src/services/elevenlabs.ts` |
| Rutas + token compartido + rate limit | `backend/src/routes.ts` |
| Firebase Admin bootstrap (Auth) | `backend/src/firebase.ts` |
| Datos: Organization/User/Membership/Session (Firestore) | `backend/src/repositories/*.ts` |
| Contexto server-side (org/rol) + selección multi-org | `backend/src/services/context.ts`, `backend/src/middleware/context.ts` |
| RBAC por rol (`requireAnyRole`) | `backend/src/middleware/roles.ts` |
| Máquina de estados de la app (7 pantallas) | `frontend/src/App.tsx` |
| Lógica de conversación (turnos, cierre por silencio) | `frontend/src/components/PracticeSession.tsx` |
| Usuarios de login + escenarios (UI) | `frontend/src/config.ts` |
| Estilos (desktop + mobile ≤900px) | `frontend/src/styles.css` |
| Docker / proxy | `docker-compose.yml`, `Caddyfile`, `backend/Dockerfile` |

## 5. Decisiones y comportamientos que NO son obvios

- **Auth + autorización (Fases 1–3)**: Firebase Auth real (email/password).
  El backend verifica el ID token (`Authorization: Bearer`, → 401 si
  inválido) y además exige una **Membership activa en una Organization
  activa** (Firestore, → 403 si no) — la allowlist de correos
  (`AUTH_ALLOWED_EMAILS`) de Fase 1 se **retiró en Fase 3**, Membership la
  reemplaza. Sobre eso, `requireAnyRole(...)` (Fase 3) filtra por rol
  cuando aplica (p. ej. `/admin/sessions` excluye SPOKESPERSON). El
  frontend reintenta una sola vez con token refrescado ante un 401; nunca
  reintenta ante un 403. No hay signup en el frontend — las cuentas se
  crean con Admin SDK, las memberships con los repositorios de
  `backend/src/repositories/`. Detalle completo en
  `PHASE_01_AUTH_IMPLEMENTATION_REPORT.md`,
  `PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md` y
  `PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md`.
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

Preparación multi-cliente: subió de **LOW** (evaluación previa a Fase 1) —
detalle actualizado en `PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md`. Lo
crítico (P0) original:
- ~~No existe el concepto de organización/tenant...~~ **Resuelto en Fase 2**
  (modelo) **y Fase 3** (aplicado a los endpoints reales).
- ~~No hay autenticación real...~~ **Resuelto en Fase 1.**
- ~~`GET /admin/sessions` devuelve sesiones de todos...~~ **Resuelto en
  Fase 3**: ahora requiere Membership + rol (AGENCY_ADMIN/CLIENT_ADMIN/
  COACH; SPOKESPERSON → 403) y solo devuelve sesiones de la organización
  resuelta del caller — nunca "todas".
- Estado de sesión en un `Map` en memoria del proceso. **Resuelto en
  Fase 4**: session lifecycle completo (estados, idempotencia,
  concurrencia) sobre Firestore, sin `Map`.
- ~~prompts/rúbricas hardcoded (cliente nuevo = código + deploy)~~
  **Resuelto en Fase 5**: prompts, rúbricas, perfiles, playbook y voces
  ahora son paquetes de configuración versionados (`backend/config-packages/`),
  validados en runtime (Zod) — agregar un cliente nuevo es agregar una
  carpeta, no tocar código. Ver `PHASE_05_ENGINE_CONFIG_REPORT.md`.

Otros (P1): sin instrumentación de latencia, rate-limit por IP (puede bloquear a
una oficina entera), sin timeouts ni retries hacia ElevenLabs/OpenRouter
más allá de lo que Fase 4 ya agregó.

Recomendación: NO migrar a Postgres (Firestore alcanza). Con Fases 1–5 ya
implementadas, el siguiente paso es Fase 6 (versioning/provenance de
configuración). Estimación original: ~48–74 días-dev (~12–17 semanas con
1 dev). Detalle completo en `SPOKESPERSON_TRAINING_SCALING_REPORT.md` y
`PLAN_TRABAJO_ESCALAMIENTO_MULTI_CLIENTE.md`.

## 9. Pendientes sugeridos

1. **Revisar y aprobar `PHASE_05_ENGINE_CONFIG_REPORT.md`, y luego
   desplegar Fases 1–5 juntas** (frontend a Firebase Hosting, backend al
   VPS — recordar el fix de `Dockerfile` para `config-packages/`) — hoy
   solo están implementadas y testeadas localmente.
2. Probar los 3 escenarios completos (no solo el genérico) con usuarios reales y
   confirmar que el cierre a los 3s de silencio se siente natural en un celular
   con conversación de voz real.
3. Decidir si `npm run sessions:mark-abandoned` se agenda en un cron real
   del VPS o se sigue corriendo a mano.
4. Considerar dominio propio para el backend (hoy `nip.io`).

## 10. Documentos existentes (solo si necesitas más detalle)

`report.md` (avance), `HANDOFF.md` (contexto de sesión previa),
`SPOKESPERSON_TRAINING_SCALING_REPORT.md` (análisis multi-cliente),
`PHASE_01_AUTH_IMPLEMENTATION_REPORT.md` (auth real),
`PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md` (Organization +
Membership + Role), `PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md` (tenant
isolation + RBAC real), `PHASE_04_SESSION_LIFECYCLE_REPORT.md` (session
lifecycle durable), `PHASE_05_ENGINE_CONFIG_REPORT.md` (ENGINE vs
CONFIG — 22-sep-2026), `ACCESOS.md` (credenciales, no versionado),
`git log` (historial con mensajes detallados de cada cambio).
