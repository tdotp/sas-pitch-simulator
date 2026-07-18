# Configuración ElevenLabs — paso a paso

El carril de voz usa **ElevenLabs Conversational AI (Agents)**. Un solo agente cubre los 3 escenarios: el backend sobreescribe (override) el prompt, el primer mensaje y la voz según el target al momento de firmar el acceso.

## 1. API Key

1. Entra a https://elevenlabs.io → Profile → **API Keys**.
2. Crea una key. Cópiala en `backend/.env`:
   ```
   ELEVENLABS_API_KEY=sk_...
   ```
3. Plan: se recomienda **Creator** o superior para Conversational AI con latencia baja.

## 2. Crear el Agent

1. Ve a **Conversational AI → Agents → Create Agent**.
2. Nombre: `SAS Vocería C-level`.
3. Idioma: **Español**.
4. El prompt y el primer mensaje del agente NO importan mucho aquí: los sobreescribimos desde el backend por escenario. Puedes dejar un prompt base corto.
5. Copia el **Agent ID** a `backend/.env`:
   ```
   ELEVENLABS_AGENT_ID=agent_...
   ```

## 3. Habilitar overrides (IMPORTANTE)

Para que el backend pueda inyectar el prompt/persona/voz por escenario, el agente debe permitir overrides:

1. En el agente → **Security** (o Advanced → Overrides).
2. Habilita override para: **System prompt**, **First message**, **Language**, **TTS voice**.
3. Guarda.

> Si no habilitas overrides, todos los escenarios sonarán igual (usarán el prompt base del dashboard).

## 4. Elegir voces (es-CO, registro ejecutivo)

En **Voices**, elige o clona voces en español latino con tono ejecutivo:

- **Davivienda** → voz **masculina** (`ELEVEN_VOICE_MALE`).
- **Grupo Aval** → voz **femenina** (`ELEVEN_VOICE_FEMALE`).
- **Genérico** → seleccionable (hombre/mujer/aleatoria). Opcionalmente agrega 2 voces extra para "aleatoria": `ELEVEN_VOICE_GENERIC_A`, `ELEVEN_VOICE_GENERIC_B`.

Copia los **Voice IDs**:

```
ELEVEN_VOICE_MALE=...
ELEVEN_VOICE_FEMALE=...
ELEVEN_VOICE_GENERIC_A=...   # opcional
ELEVEN_VOICE_GENERIC_B=...   # opcional
```

> Sugerencia: busca voces etiquetadas `es` / `Latin American`, con estilo "narration" o "conversational" y edad "middle-aged" para un registro de alto ejecutivo.

## 5. Verificar

Con el backend corriendo:

```bash
curl http://localhost:8080/api/health
# eleven_ready debe ser true
```

Luego, desde la UI: elige un escenario → **Iniciar práctica** → permite el micrófono. El agente debe saludar con la consigna del escenario.

## Notas técnicas

- El backend pide el signed URL a `GET /v1/convai/conversation/get-signed-url?agent_id=...` con header `xi-api-key`.
- Los overrides se envían desde el frontend vía `@elevenlabs/react` (`startSession({ signedUrl, connectionType: 'websocket', overrides })`).
- El transcript se arma en el cliente desde los eventos `onMessage` y se manda al backend en `/session/end`.
