# SmartPR · Simulador de vocería — prototipo desktop

Primera versión navegable del rediseño visual.

## Incluye

- Acceso
- Selección de escenario
- Preparación
- Conversación simulada con orbe animado
- Procesamiento
- Resumen editorial
- Análisis completo

## Ejecutar

Abrir `index.html` directamente o iniciar un servidor local:

```bash
python3 -m http.server 8080
```

Luego abrir `http://localhost:8080`.

## Integración futura con ElevenLabs

La interfaz expone funciones para conectar los estados del agente:

```js
window.smartprSimulator.setAgentState('listening');
window.smartprSimulator.setAgentState('thinking');
window.smartprSimulator.setAgentState('speaking');
```

La conversación actual es una simulación visual. No se almacena ninguna API key en el frontend.

## Notas

- Esta entrega está enfocada únicamente en desktop.
- El logo de SmartPR se recolorea con CSS mediante `mask-image`.
- El orbe usa SVG, CSS y JavaScript local; no depende de CodePen.
