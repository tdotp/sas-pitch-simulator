# START HERE — SAS Pitch Simulator

Pega este archivo (o dile al nuevo chat que lo lea) y podrá continuar sin leer
el resto de la documentación. Última actualización: 20 de septiembre de 2026.

## 1. Qué es

Simulador de vocería ejecutiva por voz para SAS Colombia (SmartPR). La persona
practica un pitch hablando con un interlocutor C-level simulado y recibe un
reporte de evaluación con IA. 3 escenarios: **genérico, Davivienda, Grupo Aval**.

Repo local: `/Users/gerardocalambasposada/Documents/Claude_/SAS` (monorepo npm
workspaces: `backend/`, `frontend/`). **No tiene remoto git** — vive solo en
esta máquina.

## 2. Estado (verificado el 20-sep-2026)

- En producción y respondiendo (HTTP 200 ambos):
  - Frontend: https://smartpr-pitch-agent.web.app (Firebase Hosting)
  - Backend: https://185-215-180-182.nip.io (VPS, Docker + Caddy, HTTPS vía nip.io)
- Repo limpio; último commit `dcdb256`. Sin cambios pendientes salvo el reporte
  de escalamiento (sin commitear) y un `.zip` de descarga que se ignora a propósito.
- Firestore: 68 sesiones de prueba (16 completas, 51 abandonadas).

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
- **Login**: es un gate de frontend, sin autenticación real (ver riesgos).
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
Firebase (proyecto `smartpr-pitch-agent`), y los 4 logins de la app.
Si trabajas desde otra máquina, copia esas llaves como archivos (no como texto).

## 8. Riesgos y deuda conocida (resumen del reporte de escalamiento)

Preparación multi-cliente: **LOW**. Lo crítico (P0):
- No existe el concepto de organización/tenant en ningún lado.
- No hay autenticación real (login solo en el navegador, 4 usuarios en el bundle público).
- `GET /admin/sessions` devuelve sesiones de todos sin control de acceso.
- Estado de sesión en un `Map` en memoria del proceso (se pierde al reiniciar).

Otros (P1): sin instrumentación de latencia, rate-limit por IP (puede bloquear a
una oficina entera), persistencia fire-and-forget sin reintentos, sin timeouts ni
retries hacia ElevenLabs/OpenRouter, prompts/rúbricas hardcoded (cliente nuevo =
código + deploy).

Recomendación: NO migrar a Postgres (Firestore alcanza). Primer paso si se escala:
modelo `Organization/Membership` + Firebase Auth real. Estimación: ~48–74
días-dev (~12–17 semanas con 1 dev). Detalle completo en
`SPOKESPERSON_TRAINING_SCALING_REPORT.md`.

## 9. Pendientes sugeridos

1. Probar los 3 escenarios completos (no solo el genérico) con usuarios reales y
   confirmar que el cierre a los 3s de silencio se siente natural en un celular
   con conversación de voz real.
2. Decidir si se avanza a multi-cliente (ver sección 8) o se mantiene como
   herramienta interna.
3. Crear un repo remoto privado (GitHub) — hoy el código no tiene respaldo fuera
   de esta máquina.
4. Considerar dominio propio para el backend (hoy `nip.io`).

## 10. Documentos existentes (solo si necesitas más detalle)

`report.md` (avance), `HANDOFF.md` (contexto de sesión previa),
`SPOKESPERSON_TRAINING_SCALING_REPORT.md` (análisis multi-cliente),
`ACCESOS.md` (credenciales, no versionado), `git log` (historial con mensajes
detallados de cada cambio).
