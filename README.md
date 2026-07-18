# Simulador de Vocería C-level · SAS

Aplicación web para que **Sandra Hernández** practique pitches ejecutivos de 90 s (ideal) a 3 min (máximo) frente a un interlocutor C-level por voz, y reciba una evaluación estructurada al terminar.

Tres escenarios: **Genérico**, **Davivienda** (perfil CEO banca) y **Grupo Aval** (perfil presidenta de holding).

## Arquitectura

Dos carriles para que la voz se sienta rápida y la evaluación no bloquee:

- **Carril rápido (voz):** ElevenLabs Conversational AI (Agents) maneja STT + turnos + TTS de forma nativa. El backend solo firma el acceso (signed URL) y calcula el _prompt override_ por escenario. El frontend usa `@elevenlabs/react`.
- **Carril lento (evaluación):** al terminar, el backend calcula métricas deterministas (WPM, muletillas, repeticiones, cifras, SAS, CTA) y llama a **Claude Sonnet vía OpenRouter** con la rúbrica del target. Devuelve JSON estructurado → reporte.

```
Frontend (React + Vite)                Backend (Node + Express)
  Login (hardcode)                       POST /api/session/start  → signed URL + overrides
  Selector escenario/voz                 POST /api/session/end    → métricas + evaluación Sonnet
  Sesión de voz + timer   ── /api ──►    POST /api/metrics/analyze (debug)
  Reporte final                          GET  /api/health, /api/admin/sessions
                                         Firebase Admin (persistencia, fuera del path crítico)
        │                                        │
        └──► ElevenLabs Agent (voz)              └──► OpenRouter / Claude Sonnet (evaluación)
                                                 └──► Firestore (sesiones, transcripts, scores)
```

Las llaves de ElevenLabs y OpenRouter **viven solo en el backend**. El frontend nunca las ve.

## Estructura

```
SAS/
├── backend/          Node + TS + Express
│   └── src/
│       ├── index.ts, config.ts, routes.ts, firebase.ts, types.ts
│       ├── services/  elevenlabs.ts · evaluator.ts · metrics.ts
│       └── data/      prompts.ts · rubrics.ts · profiles.ts · playbook.ts · evaluatorPrompt.ts
├── frontend/         React + TS + Vite
│   └── src/
│       ├── App.tsx, api.ts, config.ts, types.ts
│       └── components/  Login · ScenarioSelect · PracticeSession · Timer · Report
├── docs/
│   ├── SETUP_FIREBASE.md
│   └── SETUP_ELEVENLABS.md
└── package.json      (npm workspaces)
```

## Puesta en marcha (local)

Requisitos: Node ≥ 20.

```bash
# 1. Instalar (una vez)
npm install

# 2. Configurar variables
cp backend/.env.example backend/.env        # llenar llaves (ver docs/)
cp frontend/.env.example frontend/.env.local # config Firebase web + login

# 3. Correr backend y frontend (en dos terminales)
npm run dev:backend     # http://localhost:8080
npm run dev:frontend    # http://localhost:5173
```

El frontend hace proxy de `/api` al backend (ver `frontend/vite.config.ts`).

### Modo sin llaves

El backend arranca aunque falten llaves. `/api/health` reporta `eleven_ready` y `openrouter_ready`. La UI muestra un aviso si algo falta. Con `PERSISTENCE_DISABLED=true` corre sin Firebase (loguea en consola).

## Qué falta para que funcione de punta a punta

1. **ElevenLabs** → crear el Agent, habilitar overrides, elegir voces es-CO. Ver [docs/SETUP_ELEVENLABS.md](docs/SETUP_ELEVENLABS.md).
2. **OpenRouter** → `OPENROUTER_API_KEY` con saldo; confirmar slug de Claude Sonnet.
3. **Firebase** → proyecto + service account. Ver [docs/SETUP_FIREBASE.md](docs/SETUP_FIREBASE.md).

## Contenido ya cargado

- 3 prompts de entrevistador (genérico, Davivienda, Grupo Aval) con perfiles del deep research.
- 3 rúbricas (pesos suman 100) + prompt evaluador universal.
- Playbook SAS condensado (principios + cifras clave + cifras Colombia) inyectado como contexto.
- Motor de métricas en español (muletillas, repeticiones, cifras, SAS, CTA).
- Reporte completo: score, checklist, métricas, criterios, fortalezas/mejoras, pitch sugerido 90s/45s, CTA, próximo foco.
