# Reporte técnico — Estado actual y preparación para escalamiento multi-cliente

**Proyecto**: SAS Pitch Simulator (simulador de vocería ejecutiva C-level)
**Fecha del reporte**: 14 de septiembre de 2026
**Alcance**: solo inspección. No se modificó código, no se migró nada, no se desplegó nada, no se cambió infraestructura.

> **Nota de encuadre importante**: la plantilla de este reporte asume un stack con Prisma ORM y una base de datos relacional (SQL). **El proyecto real no usa Prisma ni SQL** — usa **Firestore (NoSQL, Firebase)** sin ORM, con el esquema definido únicamente por interfaces de TypeScript en código, no por un schema de base de datos. Cada sección respeta la intención original de la plantilla pero documenta lo que realmente existe, no lo que la plantilla presupone.

---

## 1. ARQUITECTURA ACTUAL

| Componente | Detalle |
|---|---|
| Framework frontend | React 18.3.1 + Vite 8.0.0 + TypeScript 5.7.3 (SPA, sin router — un solo componente `App.tsx` maneja un `switch` de "stages" en estado de React) |
| Framework backend | Node.js + Express 4.21.2 + TypeScript 5.7.3 (`type: module`, compilado con `tsc`) |
| Estructura del repo | Monorepo con npm workspaces (`backend/`, `frontend/`), sin remoto git configurado (vive solo en la máquina local) |
| ORM | **No existe.** Persistencia vía SDK oficial `firebase-admin` (Firestore), llamadas directas a la API de Firestore, sin capa de abstracción |
| Base de datos | **Firestore** (NoSQL documental), una sola colección: `sessions` |
| Autenticación | **No hay autenticación real.** Ver sección 3 |
| APIs internas | 5 endpoints REST en Express (`/health`, `/session/start`, `/session/end`, `/metrics/analyze`, `/admin/sessions`) |
| Servicios externos | ElevenLabs (voz), OpenRouter→Claude Sonnet (evaluación), Firebase/Firestore (persistencia), Firebase Hosting (frontend estático) |
| Proveedor de IA (evaluación) | Anthropic Claude Sonnet 4, vía OpenRouter (`anthropic/claude-sonnet-4`) |
| STT | **Integrado dentro de ElevenLabs Conversational AI** — no hay proveedor STT separado; ElevenLabs maneja voz→texto, turnos y síntesis en un solo servicio |
| TTS | **ElevenLabs** (mismo servicio que STT — Conversational AI Agent) |
| Almacenamiento de archivos/audio | **No existe.** No se graba ni almacena audio en ningún punto — solo la transcripción de texto que entrega ElevenLabs vía WebSocket llega al backend, nunca el audio crudo |
| Docker | Sí, solo el backend está dockerizado (`node:22-alpine`, build multi-stage) |
| Reverse proxy | Caddy 2 (imagen oficial `caddy:2-alpine`), TLS automático vía Let's Encrypt usando `nip.io` (no hay dominio propio) |
| Servidor/VPS | Ver sección 8 |
| Variables críticas de entorno | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, 4 voice IDs, `OPENROUTER_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `FIREBASE_PROJECT_ID`, `API_SHARED_TOKEN`, `CORS_ORIGINS` |
| Servicios compartidos en el VPS | Sí — `n8n` (automatización) y otro proyecto (`aleja-app`), en contenedores Docker separados, sin red compartida con este proyecto |

### Diagrama de flujo

```
usuario (navegador)
  │
  ├──► Firebase Hosting (frontend estático — React/Vite)
  │
  ├──► ElevenLabs — WebSocket directo, conexión en tiempo real
  │        (STT + turn-taking + LLM conversacional del entrevistador + TTS,
  │         todo dentro de ElevenLabs Conversational AI — NO pasa por el backend)
  │
  └──► Backend (VPS, Docker, detrás de Caddy)
           │  · POST /session/start  → arma prompt + pide signed URL a ElevenLabs
           │  · POST /session/end    → recibe transcripción, calcula métricas,
           │                           llama a Claude Sonnet, persiste
           │
           ├──► OpenRouter → Claude Sonnet 4 (evaluación del pitch, JSON)
           └──► Firebase Admin SDK → Firestore (colección `sessions`)
```

**Punto arquitectónico clave**: el backend **nunca está en la ruta de la conversación de voz en vivo**. Solo interviene al inicio (arma el prompt del escenario y pide la URL firmada) y al final (evalúa). Esto es deliberado por latencia, pero también significa que **el backend no puede observar ni intervenir la conversación mientras ocurre** — no hay forma de aplicar límites, moderación o lógica en tiempo real más allá de lo que el propio prompt del agente ElevenLabs le indique que haga.

---

## 2. MODELO DE DATOS ACTUAL

No hay modelos de Prisma. El "modelo de datos" son interfaces TypeScript (`backend/src/types.ts`) y un solo documento por sesión en Firestore.

| Entidad (equivalente conceptual) | Dónde vive | Propósito | Multi-tenant hoy |
|---|---|---|---|
| `SessionRecord` | `backend/src/types.ts` + Firestore doc | Una práctica completa: quién, qué escenario, duración, transcripción, métricas, evaluación | **No** — sin `organizationId` ni `clientId` |
| `TranscriptTurn[]` | Embebido dentro del documento de sesión (no es colección propia) | Turnos de la conversación (rol + texto) | N/A |
| `SpeechMetrics` | Embebido dentro del documento de sesión | Métricas deterministas (WPM, muletillas, cifras, CTA) | N/A |
| `EvaluationResult` | Embebido dentro del documento de sesión | Salida completa del evaluador LLM (score, criterios, feedback) | N/A |
| Rúbricas (`RUBRICS`) | **Hardcoded en código** (`backend/src/data/rubrics.ts`), no en base de datos | Criterios de evaluación por escenario | N/A — no configurable sin deploy |
| Perfiles de escenario | **Hardcoded en código** (`backend/src/data/profiles.ts`, `prompts.ts`) | Persona del entrevistador por escenario | N/A — no configurable sin deploy |
| Usuario | **No existe como entidad.** Un array hardcoded de 4 pares correo/contraseña en el código del frontend (`frontend/src/config.ts`) | Puerta de acceso simple | N/A |
| Organización/cliente | **No existe en absoluto**, ni como tabla ni como campo | — | — |

### SINGLE_TENANT_ASSUMPTIONS (hallazgos explícitos)

1. **Colección `sessions` sin ningún campo de tenant** — ni `organizationId`, ni `clientId`, ni `accountId`. Cualquier query (`listSessions()`) trae sesiones de **todo el mundo**, sin filtro.
2. **`user_id` es texto libre no verificado** — el body de `/session/start` acepta `user_id`/`user_name` como cualquier string, con default hardcoded `"sandra_hernandez"` / `"Sandra Hernández"` si no se manda nada. No hay validación de identidad contra ese `user_id`.
3. **Los 3 escenarios (`generic`, `davivienda`, `grupo_aval`) son un union type fijo** (`TargetMode` en `types.ts`) — agregar un escenario nuevo (para un cliente nuevo) requiere tocar el tipo TypeScript, el switch de prompts, el switch de rúbricas y redesplegar.
4. **Las rúbricas y los prompts del entrevistador están escritos como strings literales en archivos `.ts`** — no hay tabla `Scenario` ni `InterviewProfile` en base de datos. "Configurar un cliente nuevo" hoy = escribir código nuevo.
5. **`GET /admin/sessions` no tiene ningún control de acceso más allá del token compartido de anti-abuso** — devuelve las últimas 50 sesiones de todos los usuarios, sin filtro por dueño ni por organización. Cualquiera con el token del frontend (visible en el bundle público) puede leer todas las sesiones de todo el mundo.
6. **El login es un array estático de 4 usuarios** compartido por absolutamente todos los que usan la app — no hay concepto de "a qué organización pertenece este usuario".
7. **`API_SHARED_TOKEN`** es un secreto único, global, compartido por todos los clientes de la app — no hay un token/API-key por organización.
8. **CORS_ORIGINS** es una lista fija de 2-3 dominios en `.env` — cada cliente nuevo con dominio propio requeriría tocar esa variable y redesplegar.

---

## 3. AUTENTICACIÓN ACTUAL

**CURRENT_AUTH_MODEL: gate de frontend sin backend — no hay autenticación real.**

Paso a paso de lo que existe hoy (`frontend/src/components/Login.tsx` + `frontend/src/config.ts`):

- **Creación de usuario**: no existe un flujo. Los 4 usuarios están hardcoded como pares `{ correo, contraseña }` en texto plano dentro de `config.ts`, que se compila directo al bundle JavaScript público.
- **Inicio de sesión**: el formulario compara el correo/contraseña ingresados contra ese array **en el navegador, con JavaScript** (`Array.some(...)`). No hay ninguna llamada de red al backend para autenticar.
- **Token/cookie**: **no se emite ninguno.** El "logueado" es solo una variable de estado de React (`stage`) en memoria. Recargar la página (F5) vuelve directo a la pantalla de login.
- **Duración de sesión**: la duración de la pestaña del navegador. Cero persistencia.
- **Recuperación de contraseña**: hay un botón "¿Olvidaste tu contraseña?" en la UI que **no tiene `onClick` — no hace nada.**
- **Invitaciones**: no existen.
- **Verificación de email**: no existe.
- **Roles**: no existen — los 4 usuarios son indistinguibles entre sí una vez dentro de la app.
- **Permisos**: no existen — cualquiera logueado ve y puede hacer exactamente lo mismo.
- **Logout**: no hay botón de logout en la UI (se cierra recargando o cerrando la pestaña).
- **Protección server-side**: **ninguna.** El backend no sabe ni le importa quién hizo login en el frontend — su único control de acceso es el `API_SHARED_TOKEN` (un secreto único compartido, visible en el bundle JS, pensado solo como freno anti-bot/anti-abuso, no como autenticación de usuario — documentado explícitamente así en el propio código).

### Qué falta para soportar roles reales

| Rol propuesto | Qué falta hoy |
|---|---|
| `AGENCY_ADMIN` | Todo: modelo de usuario real, sesiones server-side, sistema de roles, panel de administración |
| `CLIENT_ADMIN` | Todo lo anterior + concepto de organización/cliente que hoy no existe en ningún punto del sistema |
| `COACH / REVIEWER` | Todo lo anterior + relación explícita "qué trainees puede ver este coach" |
| `TRAINEE / SPOKESPERSON` | Es, en la práctica, el único "rol" que existe hoy — pero sin identidad verificada real |

---

## 4. ENTREVISTADOR / HARNESS ACTUAL

Esta es la pieza más madura y mejor diseñada del sistema — y también la más rígida para multi-cliente.

### Cómo está construido

- **System prompt**: 3 funciones TypeScript (`genericPrompt()`, `daviviendaPrompt()`, `grupoAvalPrompt()` en `backend/src/data/prompts.ts`) que arman un string largo por template literal, concatenando: persona + perfil del "cliente objetivo" (`profiles.ts`) + objetivo del ejercicio + reglas comunes + flujo obligatorio de repreguntas + mensaje de cierre + resumen del playbook SAS (`playbook.ts`).
- **Personalidad**: hardcoded en prosa dentro de cada función (tono, actitud, qué rechaza, qué prioriza).
- **Reglas de repregunta**: un mecanismo bien pensado — exactamente 2 repreguntas obligatorias, la primera textual de una lista fija por escenario + una lista compartida de 6 preguntas genéricas, la segunda de la misma lista pero anclada explícitamente a la respuesta anterior de la persona. Todo esto vive como instrucciones en texto dentro del prompt (el LLM del agente de voz es quien las sigue, no hay enforcement de código sobre cuántas preguntas hace en realidad).
- **Contexto/memoria**: no hay memoria entre sesiones — cada práctica es una conversación aislada. El "contexto" es únicamente lo que se inyecta en el prompt al arrancar (perfil + playbook), fijo por escenario.
- **Escenarios**: exactamente 3, seleccionables por un union type TypeScript (`"generic" | "davivienda" | "grupo_aval"`).
- **Mensajes clave / temas sensibles / límites**: hardcoded en prosa dentro de `COMMON_RULES` y cada prompt específico (ej. "no atribuyas opiniones privadas a personas reales", "no inventes cifras").
- **Criterios de evaluación / scoring**: rúbricas hardcoded en `backend/src/data/rubrics.ts` — un objeto TypeScript por escenario, con criterios, pesos (suman 100) y reglas observables. El LLM evaluador (Claude Sonnet) recibe esta rúbrica completa como parte del prompt de evaluación y debe ceñirse a los `criterion_id` y puntos exactos.
- **Inyección de información del cliente**: vía `getProfile(target)` — una función que retorna un bloque de texto fijo por escenario (`backend/src/data/profiles.ts`), con datos públicos del "cliente objetivo" (ej. prioridades públicas de un banco). No hay forma de subir documentos propios de un cliente nuevo — hay que escribir el perfil a mano en código.

### Clasificación

| Elemento | Estado |
|---|---|
| Texto de los prompts (personalidad, reglas, cierre) | **HARDCODED** |
| Selección de qué prompt usar (`target_mode`) | **HARDCODED** (union type fijo de 3 valores) |
| Rúbricas de evaluación | **HARDCODED** |
| Perfiles de "cliente objetivo" | **HARDCODED** |
| Playbook / narrativa de marca (SAS) | **HARDCODED**, compartido por los 3 escenarios |
| Selección de voz por escenario | **HARDCODED** (`resolveVoice()` — Davivienda siempre voz masculina, Aval siempre femenina) |
| Voice IDs concretos de ElevenLabs | Configurable vía variables de entorno (4 voice IDs), pero el **mapeo escenario→voz** sigue hardcoded en código |
| Idioma | Hardcoded a `"es"` |
| Duración ideal/máxima del pitch (90s/180s) | Hardcoded en múltiples lugares (prompts, rúbricas, frontend `TIMER`) — **no hay una sola fuente de verdad**, es el mismo número repetido en 4+ archivos distintos |

### Qué exige hoy crear un cliente nuevo

**Modificar código, sí. Crear archivos, sí. Desplegar, sí.** No hay ninguna ruta "solo cargar configuración" hoy:

1. Agregar el nuevo valor al union type `TargetMode` (`types.ts`, backend y frontend deben coincidir).
2. Escribir una función de prompt nueva en `prompts.ts` (persona, reglas, preguntas).
3. Escribir una rúbrica nueva en `rubrics.ts` con pesos que sumen 100.
4. Escribir un perfil nuevo en `profiles.ts`.
5. Decidir y hardcodear la voz (`resolveVoice()`).
6. Agregar la entrada al array `TARGETS` en el frontend (`config.ts`) con label, subtítulo, color.
7. `npm run build` + redeploy de backend (VPS) y frontend (Firebase Hosting).

Esto es la brecha más grande para el objetivo de "escalar a multi-cliente" — hoy es 100% trabajo de ingeniero por cliente nuevo, no autoservicio.

---

## 5. FLUJO COMPLETO DE UNA ENTREVISTA

| # | Paso | Síncrono/Asíncrono | Local/Externo |
|---|---|---|---|
| 1 | Usuario pulsa "Comenzar" → frontend ya prefetcheó `POST /session/start` en la pantalla de preparación | Asíncrono (llamada de red) | Externo (backend propio) |
| 2 | Backend arma el prompt del escenario (`buildOverrides`) — **local, instantáneo, sin llamada a ningún LLM** | Síncrono | Local |
| 3 | Backend pide signed URL a ElevenLabs (`GET /convai/conversation/get-signed-url`) | Asíncrono | Externo (ElevenLabs) |
| 4 | Backend guarda un registro `in_progress` en memoria (`Map`) + intenta guardar en Firestore (fire-and-forget) | Asíncrono, no bloqueante | Local (Map) + Externo (Firestore) |
| 5 | Frontend recibe signed URL + overrides, abre WebSocket directo con ElevenLabs | — | Externo (ElevenLabs, directo desde el navegador) |
| 6 | **Captura de voz, STT, turnos, LLM conversacional del entrevistador, TTS** — todo dentro de ElevenLabs, en streaming por WebSocket | Streaming, asíncrono | Externo, 100% fuera del backend propio |
| 7 | El frontend arma la transcripción en memoria a partir de los mensajes que llegan por WebSocket | — | Local (navegador) |
| 8 | Repreguntas 1 y 2 — mismo mecanismo de streaming, gobernado por las instrucciones del prompt, sin intervención del backend | Streaming | Externo |
| 9 | Cierre — el frontend detecta el fin de turno (silencio tras la 2ª repregunta) y corta la sesión | Local | Local |
| 10 | `POST /session/end` con la transcripción completa | Asíncrono | Externo (backend propio) |
| 11 | Backend calcula métricas deterministas (regex, sin LLM) — `computeMetrics()` | Síncrono, rápido | Local |
| 12 | Backend llama a Claude Sonnet vía OpenRouter con transcripción + rúbrica + métricas | Asíncrono, es la llamada más lenta del flujo | Externo (OpenRouter) |
| 13 | Backend persiste resultado completo en Firestore (fire-and-forget, no bloquea la respuesta) | Asíncrono, no bloqueante | Externo (Firestore) |
| 14 | Backend responde al frontend con métricas + evaluación; frontend renderiza reporte | Síncrono (respuesta HTTP) | Local |

**Nota de robustez**: el paso 13 (persistencia) es fire-and-forget — si Firestore falla, el usuario **nunca se entera**, y ese resultado se pierde silenciosamente (solo queda un `console.error` en el log del servidor). No hay reintentos ni cola.

---

## 6. VOZ Y LATENCIA

| | |
|---|---|
| Proveedor STT | ElevenLabs (integrado en Conversational AI, no es un servicio separado) |
| Modelo STT | No expuesto/configurable desde este código — lo decide ElevenLabs internamente para el Agent |
| Proveedor LLM (conversación en vivo) | ElevenLabs Conversational AI (motor propio del Agent; el modelo subyacente no se elige desde este código) |
| Proveedor LLM (evaluación) | OpenRouter → Anthropic Claude Sonnet 4 (`anthropic/claude-sonnet-4`) |
| Proveedor TTS | ElevenLabs (mismo Agent) |
| Streaming | Sí — WebSocket nativo del SDK `@elevenlabs/react` |
| WebSocket/SSE | WebSocket, directo navegador↔ElevenLabs (no pasa por el backend propio) |
| Timeouts configurados | **Ninguno explícito** en el código propio para las llamadas a ElevenLabs o OpenRouter (usa el timeout por defecto de `fetch`, que es "sin límite" en Node) |
| Retries | **No hay ningún mecanismo de reintento** en ninguna llamada externa (ni ElevenLabs signed-url, ni OpenRouter) |
| Rate limits externos conocidos | No documentados en el código — dependen del plan contratado en ElevenLabs/OpenRouter, no verificable desde aquí |
| Manejo de errores | Básico: try/catch que traduce a HTTP 502 con el mensaje crudo del proveedor externo. Sin categorización de error (timeout vs. rate-limit vs. auth), sin reintento, sin circuit breaker |

### Latencia real observada

**No hay instrumentación de latencia en el código** (no hay logs con timestamps por etapa, no hay APM, no hay métricas exportadas). No existen logs históricos agregados a los que se pueda acceder desde este entorno de inspección.

```
STT:        no medido / no instrumentado
LLM:        no medido / no instrumentado
TTS:        no medido / no instrumentado
TOTAL TURN: no medido / no instrumentado
```

**Esto es un hallazgo en sí mismo**: para tomar decisiones informadas de escalamiento (cuántos usuarios concurrentes soporta la latencia real) hace falta instrumentar esto primero — ver sección 15 (P1).

---

## 7. CONCURRENCIA

| Recurso | Riesgo con múltiples usuarios simultáneos |
|---|---|
| `Map<string, SessionRecord>` en memoria (`routes.ts`) | **HIGH_RISK.** Estado compartido de un solo proceso Node. Crece sin límite (nunca se borran entradas) — con uso sostenido es una fuga de memoria lenta. Si el proceso se reinicia (crash, redeploy), **todas las sesiones `in_progress` en memoria se pierden** y `/session/end` cae al fallback `target: "generic"` porque ya no encuentra el registro. |
| Firestore | **LOW_RISK** para lectura/escritura concurrente — Firestore está diseñado para eso, y aquí no hay transacciones ni locks que puedan chocar. |
| Backend Node/Express | **MEDIUM_RISK.** Un solo proceso, un solo contenedor, sin `cluster` ni réplicas en `docker-compose.yml`. Node es single-threaded para JS — las operaciones I/O-bound (llamadas HTTP externas) no bloquean, pero **no hay ningún límite de concurrencia propio** más allá del rate-limit de 20 req/min **por IP** (no por usuario, no global). |
| ElevenLabs / OpenRouter | **MEDIUM_RISK — desconocido.** Los límites reales de la cuenta contratada no están documentados en el código ni son verificables desde esta inspección. Con muchos usuarios simultáneos generando llamadas a `/session/start` (cada una golpea a ElevenLabs) y `/session/end` (cada una golpea a OpenRouter), el primer cuello de botella real probablemente esté ahí, no en el VPS. |
| VPS (6 vCPU / 11GB RAM, ver sección 8) | **LOW_RISK** para la carga liviana que representa este backend (I/O-bound, sin cómputo pesado propio) — pero comparte recursos con `n8n` y otro proyecto en el mismo servidor. |
| Rate limit propio (`express-rate-limit`) | 20 req/min **por IP**. Con usuarios detrás de la misma IP corporativa/NAT (ej. toda una oficina de un cliente), este límite se agota rápido y **bloquea a usuarios legítimos**, no solo abuso — riesgo real para el caso multi-cliente. |
| Race conditions | **MEDIUM_RISK** en el `Map` en memoria: dos requests casi simultáneas a `/session/start` con el mismo `session_id` (aunque hoy `session_id` se genera server-side con `randomUUID()`, así que colisión real es improbable) — el riesgo mayor es el mencionado arriba (pérdida de estado ante reinicio del proceso), no colisión entre usuarios distintos. |

### Estimación cualitativa por escala

| Usuarios simultáneos | Evaluación |
|---|---|
| 1 | Sin problema — es el caso para el que se construyó y probó |
| 5 | Probablemente sin problema, pero sin datos reales que lo confirmen (ver sección 6) |
| 10 | El rate-limit por IP empieza a ser un riesgo real si hay usuarios detrás de la misma red |
| 20 | Riesgo medio: sin instrumentación de latencia ni límites explícitos hacia ElevenLabs/OpenRouter, no hay forma de predecir el comportamiento con confianza |
| 50 | No recomendable sin antes: instrumentar latencia, confirmar límites reales de las cuentas externas, y resolver el estado en memoria de un solo proceso |

**No se hizo (ni se puede hacer sin autorización) una prueba de carga real** — esta sección es análisis arquitectónico, no benchmark.

---

## 8. INFRAESTRUCTURA ACTUAL

| | |
|---|---|
| Proveedor | VPS genérico (no identificable el proveedor exacto desde el sistema operativo) |
| CPU | 6 vCPU (AMD EPYC) |
| RAM | 11 GiB total, ~6.3 GiB libres al momento de la inspección |
| Disco | 193 GB total, 52 GB usados (27%), 141 GB libres |
| Sistema operativo | Ubuntu 24.04.4 LTS |
| Docker | v29.1.3, Docker Compose v2.40.3 |
| Contenedores propios de este proyecto | `sas-pitch-simulator-backend-1` (Node/Express) + `sas-pitch-simulator-caddy-1` (reverse proxy/TLS) |
| Puertos expuestos | Solo 80/443 (Caddy) — el backend (8080) **no está expuesto directamente al host**, solo accesible dentro de la red Docker interna |
| Reverse proxy | Caddy 2, TLS automático vía Let's Encrypt sobre `185-215-180-182.nip.io` (sin dominio propio) |
| Otros proyectos en el mismo VPS | `n8n` (automatización, 2 contenedores: app + Postgres) y `aleja-app` (otro proyecto, no relacionado) — en redes Docker separadas, sin compartir recursos de red con este proyecto |

### Viabilidad para múltiples usuarios simultáneos

La infraestructura en sí (6 vCPU / 11GB) tiene margen de sobra para la carga que un backend I/O-bound como este genera — el cuello de botella esperable **no es CPU/RAM del VPS**, sino: (a) el estado en memoria de un solo proceso (sección 7), (b) límites de las cuentas externas de ElevenLabs/OpenRouter (desconocidos desde aquí), y (c) el rate-limit por IP que puede bloquear tráfico legítimo de un cliente con muchos usuarios en la misma red.

---

## 9. BASE DE DATOS

| | |
|---|---|
| Motor | Firestore (Google Cloud, NoSQL documental) |
| Colecciones | Una sola: `sessions` |
| Documentos actuales | **68** (dato real, verificado por inspección directa al momento de escribir este reporte) |
| Estado de esos documentos | 16 `completed` (con evaluación completa), 51 `in_progress` (nunca llegaron a `/session/end` — abandonos, pruebas, o pérdidas de conexión) |
| Tamaño promedio por documento | ~2.85 KB |
| Tamaño total actual | ~190 KB (trivial) |
| Usuarios | No aplica como entidad — no hay colección de usuarios |
| Backups | **No hay estrategia de backup configurada** en este proyecto (Firestore tiene point-in-time recovery disponible a nivel de proyecto GCP si está activado, pero eso no se configuró desde este código ni se pudo confirmar en esta inspección) |
| Migrations | No aplica — Firestore es schema-less, no hay migraciones que correr |
| Índices | Uno implícito (orden por `created_at desc` en `listSessions()`) — con solo 68 documentos, Firestore no necesita índice compuesto explícito |

### KEEP_CURRENT_DB vs MIGRATE_TO_POSTGRES

**Recomendación: KEEP_CURRENT_DB (Firestore) por ahora, con extensiones, no migración completa.**

Razones concretas:
- El volumen actual (68 documentos, ~190KB) está lejísimos de cualquier límite de Firestore.
- El patrón de acceso (leer/escribir un documento de sesión completo, listar últimas N) es exactamente el caso de uso para el que Firestore está optimizado.
- Multi-tenant **no requiere Postgres** — se resuelve agregando `organizationId` como campo indexado y filtrando queries por él (Firestore soporta esto bien con índices compuestos).
- Migrar a Postgres introduce trabajo real (ORM nuevo, schema, migraciones, hosting de la base) sin resolver ningún problema que Firestore tenga hoy.
- La única razón real para considerar Postgres a futuro sería necesidad de **queries relacionales complejas** (ej. reportes cross-organización con joins pesados, analítica agregada compleja) — no es el caso hoy ni en el corto plazo visible.

---

## 10. RESULTADOS Y ANALYTICS

### Métricas que existen hoy

**Deterministas (calculadas por regex, sin LLM)** — `backend/src/services/metrics.ts`:
- Conteo de palabras y palabras por minuto
- Muletillas (11 patrones para español colombiano: "eh", "este", "o sea", "digamos", "pues", "como que", "entonces", "básicamente", "digo", "verdad", "mmm")
- Repeticiones de palabras de contenido (≥4 letras, usadas 3+ veces)
- Detección de cifras (porcentajes, moneda, magnitudes, números escritos)
- Mención de "SAS"
- Detección de call-to-action (12 patrones léxicos)

**Generadas por LLM (Claude Sonnet, no deterministas)**:
- Score global (0-100) y nivel de preparación (bajo/medio/alto/sobresaliente)
- Score por criterio de rúbrica (8-10 criterios según escenario, con evidencia y recomendación)
- Fortalezas, áreas de mejora, banderas críticas
- Mejor y peor frase del usuario
- Pitch sugerido (90s y 45s), CTA recomendado
- Feedback de coach en prosa

### Dónde se almacenan

Todo embebido dentro del mismo documento Firestore de la sesión — no hay tablas/colecciones separadas para métricas ni para resultados.

### Qué ve el usuario

Pantalla de reporte (resumen editorial) + pantalla de análisis completo (todos los criterios, recomendaciones, pitch sugerido).

### Qué podría ver un administrador

Hoy: nada especial — `GET /admin/sessions` existe pero no tiene UI propia, y como se documentó en la sección 2, no filtra por dueño ni organización.

### Comparaciones entre sesiones

**No existen.** Cada evaluación es independiente; no hay tracking de progreso de un mismo usuario a través del tiempo, ni comparación entre intentos.

---

## 11. PRIVACIDAD Y AISLAMIENTO

Hallazgos de revisión arquitectónica (no se hizo pentest destructivo, solo lectura de código):

| Hallazgo | Severidad |
|---|---|
| `listSessions()` no tiene ningún filtro — trae las últimas 50 sesiones de **todos los usuarios/organizaciones** sin distinción | **Alto** — bloquea cualquier intento de multi-tenant real |
| `GET /admin/sessions` no verifica quién hace la llamada más allá del token compartido — **cualquiera con el token del bundle JS público puede leerlo** | **Alto** |
| `user_id`/`user_name` en `/session/start` son texto libre sin verificar — nada impide que un cliente mande el `user_id` de otro | **Medio** — hoy no importa mucho porque no hay ownership que proteger, pero es una brecha que hay que cerrar antes de que sí importe |
| `session_id` se genera con `randomUUID()` (v4, no predecible) — esto **sí está bien** para evitar adivinar IDs de otras sesiones | Positivo, mantenerlo |
| No hay archivos de audio almacenados en ningún punto — elimina una superficie entera de riesgo de privacidad (no hay grabaciones que proteger) | Positivo |
| El login del frontend no aísla nada — los 4 usuarios ven exactamente los mismos escenarios y no hay separación de datos entre ellos | **Alto** para el objetivo multi-cliente, aunque hoy son todos del mismo equipo interno |
| CORS está limitado a una lista fija de orígenes (`CORS_ORIGINS`) — esto sí ayuda a que solo el frontend legítimo pueda llamar al backend desde un navegador, aunque no protege contra llamadas directas (curl, Postman) con el token correcto | Parcialmente positivo |

**Conclusión de la sección**: hoy **no hay ningún mecanismo que impida que el Cliente A vea datos del Cliente B**, porque el concepto de "Cliente" no existe en absoluto en el sistema. No es que el aislamiento esté mal implementado — es que no está implementado, porque no hace falta con un solo cliente interno.

---

## 12. QUÉ HARÍA FALTA PARA MULTI-TENANT

Modelo mínimo propuesto (en términos de colecciones Firestore, ya que no hay Prisma):

```
organizations/{orgId}
  - name, plan, createdAt, settings

organizations/{orgId}/members/{userId}
  - role (agency_admin | client_admin | coach | trainee)
  - email, invitedAt, acceptedAt

organizations/{orgId}/scenarios/{scenarioId}
  - label, subtitle, systemPromptTemplate, firstMessage,
    voiceId, rubric, clientProfile   ← esto es lo que hoy vive
                                        hardcoded en prompts.ts/rubrics.ts/profiles.ts

organizations/{orgId}/sessions/{sessionId}
  - (lo que ya existe hoy en `sessions`, pero anidado bajo la organización)

users/{userId}
  - email, name, (auth real — ver sección 3)
```

| Entidad/módulo actual | Acción |
|---|---|
| `SessionRecord` / colección `sessions` | **MODIFY** — agregar `organizationId`, mover a subcolección o agregar campo indexado |
| `TargetMode` (union type de 3 escenarios) | **MODIFY → reemplazar por datos** — de union type fijo a documentos `scenarios` cargables dinámicamente |
| `RUBRICS` (hardcoded) | **MODIFY → mover a Firestore/config**, uno por escenario por organización |
| `profiles.ts` / `prompts.ts` | **MODIFY → convertir en templates parametrizables**, con los textos específicos del cliente cargados desde datos, no desde código |
| `APP_USERS` (array hardcoded en frontend) | **DEPRECATE completamente** — reemplazar por autenticación real (Firebase Auth es la opción más natural dado que ya está el SDK y el proyecto Firebase) |
| `GET /admin/sessions` | **MODIFY** — agregar filtro obligatorio por organización + verificación de rol |
| `computeMetrics()` | **KEEP** — es genérico, no tiene ninguna asunción single-tenant |
| Evaluador (`evaluator.ts`, `evaluatorPrompt.ts`) | **KEEP la mecánica, MODIFY la fuente de la rúbrica** — hoy lee de `rubrics.ts` hardcoded, debería leer de la config del escenario de la organización |
| `API_SHARED_TOKEN` (token único global) | **NEW** — reemplazar o complementar con autenticación real por usuario/organización |
| Servicio ElevenLabs (`elevenlabs.ts`) | **MODIFY** — `resolveVoice()` hoy asume 3 escenarios fijos; debe volverse data-driven |

---

## 13. ROLES PROPUESTOS

| Rol | Ver | Editar | Crear | Resultados |
|---|---|---|---|---|
| `SUPER_ADMIN` (interno SmartPR/SAS) | Todo, todas las organizaciones | Configuración global, planes | Organizaciones nuevas | Todo |
| `CLIENT_ADMIN` | Su organización completa | Escenarios, perfiles, usuarios de su org | Escenarios propios, invitar usuarios | Todos los de su organización |
| `COACH / REVIEWER` | Trainees asignados a él dentro de su org | Nada de configuración | Nada | Solo de sus trainees asignados |
| `TRAINEE / SPOKESPERSON` | Solo sus propias sesiones | Nada | Nada (solo practicar) | Solo las suyas |

Dado que la arquitectura actual es tan simple (un solo equipo, un solo conjunto de escenarios), este modelo de 4 roles es razonable y no exige nada más complejo — no hace falta un sistema de permisos granular tipo RBAC con matrices de permisos por acción; 4 roles fijos con las reglas de arriba cubren el caso de uso descrito.

---

## 14. ONBOARDING DE UN CLIENTE NUEVO

### Cómo sería HOY

1. Un ingeniero escribe una función de prompt nueva en `prompts.ts`.
2. Escribe una rúbrica nueva en `rubrics.ts`.
3. Escribe un perfil nuevo en `profiles.ts`.
4. Decide y hardcodea qué voz de ElevenLabs usar.
5. Agrega la entrada al frontend (`config.ts`).
6. Corre `npm run build`, hace commit, redespliega backend (VPS) y frontend (Firebase Hosting).
7. No hay usuarios "del cliente" — se les daría acceso agregando su correo al array `APP_USERS` (mismo credential set que todos los demás).

**Tiempo estimado hoy por cliente nuevo**: medio día a un día de trabajo de ingeniería, sin contar ida y vuelta de contenido/aprobación.

### Flujo deseado (según lo pedido)

```
crear organización
  → cargar contexto (documentos, brief del cliente)
  → cargar mensajes clave / temas sensibles
  → configurar entrevistador (persona, reglas) — asistido, no desde cero
  → crear escenarios (posiblemente generados por IA a partir del contexto cargado)
  → QA (probar la conversación antes de activar)
  → invitar usuarios (roles: admin, coach, trainee)
  → activar
```

### Qué puede automatizarse

- **Generación asistida de rúbrica y prompt** a partir de documentos del cliente (usar un LLM para el primer borrador, con revisión humana antes de activar) — es plausible dado que ya existe toda la infraestructura de prompts estructurados.
- **Invitaciones de usuario** — trivial una vez exista autenticación real (Firebase Auth tiene esto out-of-the-box).
- **QA automatizado básico** — correr una sesión de prueba sintética contra el escenario nuevo antes de activarlo, verificando que el prompt genera al menos las 2 repreguntas esperadas.
- Lo que **no** puede automatizarse fácilmente: la validación humana de que el tono/contenido del entrevistador generado por IA para un cliente nuevo es apropiado — eso necesita revisión humana antes de exponerlo a usuarios reales.

---

## 15. DEUDA TÉCNICA PARA ESCALAR

### P0 — bloquea multi-cliente o riesgo grave

- No existe el concepto de organización/tenant en ningún punto del sistema (secciones 2, 11, 12).
- No hay autenticación real — el login es cosmético, sin backend, sin sesión, sin protección server-side (sección 3).
- `GET /admin/sessions` expone todas las sesiones de todos los usuarios sin control de acceso real.
- Estado de sesión en memoria (`Map` en `routes.ts`) — se pierde en cada reinicio del proceso, y es un patrón que no escala a múltiples instancias del backend.

### P1 — debe resolverse antes del piloto multiusuario

- Cero instrumentación de latencia (sección 6) — no se puede predecir comportamiento bajo carga real sin esto.
- Rate-limit por IP (no por usuario/organización) puede bloquear tráfico legítimo de un cliente con muchos usuarios en la misma red.
- Persistencia fire-and-forget sin reintentos — resultados de evaluación se pueden perder silenciosamente si Firestore falla en ese instante.
- Prompts/rúbricas/perfiles hardcoded en código — cada cliente nuevo hoy exige deploy de ingeniería (sección 4, 14).
- Sin timeouts ni reintentos en llamadas a ElevenLabs/OpenRouter — un proveedor externo lento cuelga la request indefinidamente.

### P2 — mejora importante pero no bloqueante

- El botón "¿Olvidaste tu contraseña?" no hace nada — hay que quitarlo o implementarlo antes de multi-cliente real.
- No hay backup explícito de Firestore configurado.
- 51 de 68 documentos en Firestore están en `in_progress` permanente (sesiones abandonadas) — sin limpieza ni TTL.
- Duración ideal/máxima del pitch (90s/180s) repetida como literal en 4+ lugares distintos del código en vez de una sola fuente de verdad.

### P3 — nice-to-have

- No hay comparación de progreso entre sesiones de un mismo usuario.
- No hay logout explícito en la UI.
- El asset `SAS_Logo_White.png` (PNG viejo) sigue en el repo sin usarse, reemplazado por el SVG — limpieza menor.

---

## 16. ESTIMACIÓN

Basada en el código real inspeccionado (~1,555 líneas backend + ~1,500 líneas frontend, arquitectura simple sin deuda estructural severa fuera de lo ya documentado). Supuestos explícitos abajo de la tabla.

| Fase | Alcance | Developer-days | Semanas calendario* |
|---|---|---|---|
| **A** — Multi-tenant + Organization | Modelo de datos con `organizationId`, migración de la colección `sessions` existente (68 docs, trivial), filtrado de queries | 5–8 | 1.5–2 |
| **B** — Auth, invitaciones y roles | Firebase Auth real, 4 roles, sesiones server-side, invitaciones por email | 8–12 | 2–3 |
| **C** — Harness configurable por cliente | Mover prompts/rúbricas/perfiles de código a datos (Firestore), UI de administración para editarlos, generación asistida por IA del primer borrador | 12–18 | 3–4 |
| **D** — Dashboards por rol | Vistas para `CLIENT_ADMIN` y `COACH` (listar trainees, ver resultados agregados, comparaciones básicas) | 8–12 | 2–3 |
| **E** — PostgreSQL / storage | **No requerido según el análisis de la sección 9** — si se decidiera igual hacerlo por otras razones de negocio, estimar aparte (~10-15 días) | 0 (no recomendado ahora) | 0 |
| **F** — Hardening y aislamiento | Cerrar brechas P0/P1 de la sección 15: admin endpoint, rate-limit por org, timeouts/retries, instrumentación de latencia | 6–10 | 1.5–2.5 |
| **G** — Prueba de carga | Instrumentar, definir escenarios de carga, ejecutar contra staging, ajustar según resultados | 4–6 | 1–1.5 |
| **H** — Piloto con 2–3 clientes | Onboarding real, soporte durante piloto, ajustes basados en feedback | 5–8 (+ tiempo de calendario del piloto en sí, no solo desarrollo) | 2–4 (incluye tiempo de piloto corriendo, no solo código) |

**Total desarrollo (A–D, F, G, sin E)**: **~48–74 developer-days** ≈ **~12–17 semanas calendario** con 1 desarrollador a tiempo completo, o proporcionalmente menos con más de uno trabajando en paralelo en fases independientes (ej. C y D pueden avanzar en paralelo una vez A esté listo).

**Supuestos**:
- Un desarrollador senior full-stack familiarizado con TypeScript/React/Firebase, sin curva de aprendizaje adicional.
- No se re-arquitecta el motor de voz (ElevenLabs se mantiene tal cual).
- Firebase Auth como solución de autenticación (evita construir auth desde cero, ya está el SDK en el proyecto).
- Las fases pueden solaparse parcialmente; la suma lineal es un techo conservador, no un piso.
- No incluye trabajo de diseño/UX para las pantallas nuevas de administración — solo desarrollo.

---

## 17. ENTREGABLE — RESUMEN EJECUTIVO

```
CURRENT_ARCHITECTURE: React 18 + Vite (frontend) / Node.js + Express (backend) /
  Firestore (NoSQL, sin ORM) / ElevenLabs Conversational AI (STT+LLM+TTS
  integrados) / Claude Sonnet 4 vía OpenRouter (evaluación) / Docker + Caddy
  en VPS compartido (backend) + Firebase Hosting (frontend)

CURRENT_AUTH: Gate cosmético de frontend, sin backend, sin sesión, sin
  protección server-side. 4 usuarios hardcoded en el bundle JS público.

CURRENT_DATABASE: Firestore, colección única `sessions`, 68 documentos
  (~190KB total), sin backup configurado, sin campos de tenant.

CURRENT_DEPLOYMENT: Backend dockerizado en VPS compartido (6 vCPU/11GB,
  Ubuntu 24.04) detrás de Caddy con TLS vía nip.io; frontend en Firebase
  Hosting. Sin réplicas, sin CI/CD automatizado, deploy manual vía SSH/CLI.

CURRENT_CONCURRENCY_RISK: MEDIUM — el riesgo no está en el VPS (sobra
  capacidad) sino en el estado en memoria de un solo proceso Node y en
  límites desconocidos de las cuentas externas (ElevenLabs/OpenRouter).

MULTITENANT_READINESS: LOW

P0:
  - No existe el concepto de organización/tenant en ningún punto del sistema.
  - No hay autenticación real (login cosmético sin backend).
  - GET /admin/sessions expone todas las sesiones de todos sin control de acceso.
  - Estado de sesión en memoria (Map) — se pierde al reiniciar, no escala a
    múltiples instancias.

P1:
  - Cero instrumentación de latencia (STT/LLM/TTS/turno total).
  - Rate-limit por IP, no por usuario/organización.
  - Persistencia fire-and-forget sin reintentos ni cola.
  - Prompts/rúbricas/perfiles hardcoded — cliente nuevo exige deploy de código.
  - Sin timeouts ni reintentos en llamadas a ElevenLabs/OpenRouter.

P2:
  - Botón "olvidé mi contraseña" no funcional.
  - Sin backup explícito de Firestore.
  - 51/68 sesiones quedaron in_progress permanente, sin limpieza/TTL.
  - Duración ideal/máxima repetida como literal en 4+ lugares del código.

P3:
  - Sin comparación de progreso entre sesiones de un mismo usuario.
  - Sin logout explícito en la UI.
  - Asset PNG viejo sin usar, ya reemplazado por SVG, sin limpiar del repo.

POSTGRES_REQUIRED_NOW: NO
SERVER_UPGRADE_REQUIRED_NOW: NO
AUTH_REWORK_REQUIRED: YES
HARNESS_REFACTOR_REQUIRED: YES

ESTIMATED_DEV_DAYS: 48–74 (sin migración a Postgres, que no se considera necesaria)
ESTIMATED_CALENDAR_WEEKS: 12–17 (con 1 desarrollador full-time; menos con
  paralelización entre fases independientes)

RECOMMENDED_FIRST_STEP: Definir y construir el modelo mínimo de
  Organization/Membership (Fase A) junto con la migración de auth a Firebase
  Auth (Fase B) — son las dos piezas P0 de las que depende todo lo demás
  (harness configurable, dashboards por rol, y el aislamiento real entre
  clientes). Hacerlo antes de invertir en cualquier otra fase, porque las
  fases C/D/F asumen que ya existe una organización a la cual anclar los
  datos.
```

---

*Fin del reporte. No se modificó código, no se migró ninguna base de datos,
no se desplegó nada, y no se cambió infraestructura durante esta inspección.*
