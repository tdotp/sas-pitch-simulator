# SAS · Simulador de vocería responsive

Proyecto estático en HTML, CSS y JavaScript. No requiere compilación ni dependencias.

## Ejecutar localmente

No abrir directamente con `file://` si se desea probar el modo instalable o el service worker.

```bash
python3 -m http.server 8080
```

Abrir `http://localhost:8080`.

## Estructura

- `index.html`: pantallas y componentes.
- `styles.css`: estilos desktop, tablet y mobile.
- `app.js`: navegación del demo, escenarios, temporizador y estados del orbe.
- `manifest.webmanifest`: configuración PWA/standalone.
- `service-worker.js`: caché básica para uso offline.
- `assets/`: logos, fondos desktop/mobile e iconos.

## Breakpoints

- Desktop: más de 1100 px.
- Tablet: 901–1100 px.
- Mobile: hasta 900 px.
- Ajustes compactos: hasta 430 px y pantallas bajas.

## Puntos de integración

La interfaz expone:

```js
window.smartprSimulator.showScreen('conversation');
window.smartprSimulator.selectScenario('davivienda');
window.smartprSimulator.setAgentState('listening');
window.smartprSimulator.setAgentState('thinking');
window.smartprSimulator.setAgentState('speaking');
window.smartprSimulator.finishSession();
```

Para ElevenLabs, reemplazar el timeout de demostración por los eventos reales del agente:

- agente comienza a hablar → `setAgentState('speaking')`
- agente termina de hablar / usuario responde → `setAgentState('listening')`
- procesamiento del agente → `setAgentState('thinking')`

## Fondos mobile incluidos

- `bg-login-mobile.png`
- `bg-selection-mobile.png`
- `bg-preparation-mobile.png`
- `bg-conversation-mobile.png`

La aplicación usa `100dvh`, safe areas de iOS y layouts con scroll cuando el contenido supera la altura disponible.

## Ajustes v2
- SmartPR es la marca principal en la esquina superior izquierda de todas las pantallas.
- En conversación: SmartPR a la izquierda y SAS a la derecha, tanto en desktop como en mobile.
- Se eliminó el orbe de preparación en mobile; el orbe de conversación conserva la animación por estados.
- Se incrementó la versión de caché del service worker para evitar que el navegador muestre recursos anteriores.
