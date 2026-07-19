# SAS Pitch Simulator — Reporte de avance

Última actualización: 19 de julio de 2026.

## Qué es

Simulador de vocería ejecutiva para SAS Colombia. Sandra (u otra persona del
equipo) practica un pitch por voz en tiempo real contra un interlocutor
C-level simulado (3 escenarios: genérico, Davivienda, Grupo Aval), y recibe
un reporte de evaluación generado por IA al terminar.

## Estado: en producción

| Capa | URL | Estado |
|---|---|---|
| Frontend | https://smartpr-pitch-agent.web.app | ✅ Firebase Hosting |
| Backend | https://185-215-180-182.nip.io | ✅ VPS + Docker + Caddy (HTTPS real) |

## Arquitectura

```
Usuario (navegador, desktop o mobile)
   │
   ├──► Firebase Hosting (frontend React + Vite)
   │        │
   │        ├──► ElevenLabs — WebSocket directo, voz en tiempo real
   │        │    (no pasa por el backend, así se mantiene rápido)
   │        │
   │        └──► Backend (VPS, Docker, detrás de Caddy con TLS)
   │                  │
   │                  ├──► OpenRouter → Claude Sonnet (evaluación del pitch)
   │                  └──► Firebase Admin SDK → Firestore (guarda sesiones)
```

El VPS es compartido con otros proyectos (n8n, openclaw) — el backend corre
aislado en su propia red Docker (`sas-pitch-simulator-net`), sin tocarlos.

## Qué se construyó

### Backend (Node/Express + TypeScript)
- 3 prompts de interlocutor (genérico, Davivienda, Grupo Aval), cada uno con
  flujo de exactamente 2 repreguntas: la primera textual de una lista fija,
  la segunda de la misma lista pero anclada a lo que el usuario respondió.
- Rúbricas de evaluación por escenario (8 criterios, pesos distintos).
- Motor de métricas de habla en español (palabras/min, muletillas,
  repeticiones, cifras, mención de SAS, call to action).
- Integración ElevenLabs: signed URL + overrides de prompt/voz/idioma por
  escenario, un solo Agent cubre los 3 modos.
- Integración OpenRouter/Claude Sonnet para la evaluación post-sesión.
- Persistencia en Firestore (sesión, transcripción, métricas, evaluación).
- Protección básica: token compartido + rate limit (20 req/min por IP) en
  todas las rutas excepto `/health`.

### Frontend (React + Vite + TypeScript)
- 7 pantallas: login, selección de escenario, preparación, conversación
  (con orbe animado reactivo al estado del agente), procesando, reporte
  editorial, análisis completo.
- Diseño de marca SmartPR/SAS (paleta vino/crema) integrado desde los
  archivos de diseño entregados, con layout responsive completo para
  mobile (breakpoints, safe-areas de iOS, layouts adaptados por pantalla).
- Timer con corte grácil a los 3 minutos: nunca corta una respuesta a la
  mitad, espera a que el usuario termine su turno.
- Login con múltiples cuentas del equipo (gate simple, no autenticación
  real de servidor).

### Infraestructura
- Backend dockerizado, desplegado en VPS vía `docker compose`, con Caddy
  como reverse proxy dando HTTPS automático (Let's Encrypt vía nip.io).
- Frontend en Firebase Hosting.
- Acceso al VPS vía usuario Linux dedicado sin privilegios de root, con
  llave SSH propia.

## Verificado

- Conversación de voz real de punta a punta (ElevenLabs conectando,
  hablando la consigna, escuchando la respuesta).
- Evaluación real con Claude Sonnet (scores, criterios, recomendaciones).
- Persistencia real en Firestore.
- Las 7 pantallas en desktop y en mobile, sin regresiones cruzadas.
- Deploy de punta a punta (Firebase Hosting ↔ VPS) sin errores de CORS.

## Pendiente / próximos pasos sugeridos

- Probar los 3 escenarios completos con usuarios reales del equipo (no solo
  el genérico) y recoger feedback sobre las preguntas y el tono.
- Considerar un dominio propio para el backend (hoy usa `nip.io` como
  solución rápida) si se quiere ver más profesional a largo plazo.
- El repositorio de git vive solo en esta máquina — no hay remoto en
  GitHub/GitLab. Si se necesita colaborar con más gente o tener respaldo
  fuera de este equipo, vale la pena crear uno.
- Ver `ACCESOS.md` (local, no está en git) para credenciales operativas si
  hay que administrar el proyecto desde otra computadora.
