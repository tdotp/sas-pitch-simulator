# Prompt para Claude (diseño UI/UX) — Simulador de Vocería SAS

Copia y pega todo lo que está debajo de la línea en una conversación nueva de Claude
(idealmente pidiendo un **Artifact** de alta fidelidad o mockups HTML/React). Ajusta
lo que quieras. Está escrito para que Claude tenga contexto de pantallas, estados y
animaciones sin necesidad de ver el código.

---

Eres un diseñador de producto senior especializado en interfaces para software
empresarial (B2B), con foco en herramientas de coaching y performance. Quiero que
diseñes la UI/UX de una web app y me entregues mockups de alta fidelidad (prefiero
un Artifact en HTML+CSS, responsivo, con las animaciones descritas ya implementadas
en CSS/JS ligero). Trabaja en **español (Colombia)**.

## Producto

**Simulador de Vocería C-level de SAS.** Una web app donde una vocera ejecutiva
(Sandra) practica un "pitch" de negocio de 90 segundos (ideal) a 3 minutos (máximo)
hablando por voz con un interlocutor simulado de nivel C-level. Al terminar recibe
una evaluación estructurada con score, métricas de habla y recomendaciones. No es un
chatbot: es un simulador de entrenamiento de alto desempeño.

## Marca y tono visual

- SAS: líder global en IA y analítica. Claim: *The Power to Know*. 50 años de trayectoria.
- Personalidad: **ejecutiva, sobria, confiable, precisa**. Nada infantil ni "startup ruidosa".
- Color base sugerido: azul SAS `#0072C6`, tinta `#0B1F33`, fondo claro `#F4F7FB`.
  Acentos por escenario: Davivienda rojo `#E4002B`, Grupo Aval azul `#003DA5`.
- Semáforo de estados: ok `#1F9D55`, aviso `#D98A00`, alerta `#E4002B`.
- Tipografía: sans serif moderna, legible, tono corporativo (Inter, Söhne o similar).
- Sensación: dashboards financieros premium + calma. Aire, jerarquía tipográfica clara,
  bordes suaves (radius ~16px), sombras sutiles.

## Usuaria

Sandra, ejecutiva de comunicaciones. Usa la herramienta antes de reuniones reales con
CEOs. Necesita foco, cero fricción, y feedback que se sienta serio y accionable.

## Pantallas a diseñar (5 estados principales)

### 1. Login
- Minimalista, centrado. Logo SAS, título "Simulador de Vocería C-level", usuario +
  contraseña, botón "Ingresar". Un solo usuario (interno).
- Animación: entrada suave de la tarjeta (fade + slight rise). Fondo con un gradiente
  radial muy sutil, casi imperceptible, opcional partícula/halo de "inteligencia".

### 2. Selección de escenario
- Título "Elige tu escenario de práctica" + instrucción (pitch 90 s, incluir cifra,
  mencionar SAS, cerrar con siguiente paso).
- **3 tarjetas** de escenario: Genérico, Davivienda (perfil CEO banca), Grupo Aval
  (perfil presidenta de holding). Cada una con un punto de color de acento, título y
  subtítulo de una línea.
- Solo para "Genérico": selector de voz (Aleatoria / Hombre / Mujer) tipo chips.
- Botón "Iniciar práctica" + nota "Necesitas permitir el micrófono".
- Animación: hover con leve elevación; selección con borde de acento + glow; el bloque
  de voz aparece/desaparece con height/opacity transition al cambiar de escenario.

### 3. Sesión de voz en vivo (la pantalla clave)
- Estado "En vivo" / "Conectando…" como pill.
- Un **orbe/visualizador** central que pulsa cuando el interlocutor habla (represéntalo
  como una animación de voz, no una cara).
- **Timer grande** (mm:ss) que es protagonista, con una **barra de progreso** hacia el
  máximo de 3:00. Cambios de color por tramo:
  - 0:00–0:60 neutro (tinta)
  - 1:00–1:30 azul (acercándose al ideal de 1:30)
  - 1:30–3:00 ámbar (superó el ideal, sigue dentro del máximo)
  - 3:00 rojo + auto-corte
  Muestra leyenda "Ideal 1:30 / Máximo 3:00".
- Transcript en vivo opcional debajo (burbujas usuario/agente).
- Botones: "Finalizar y evaluar" (primario, rojo/acento) y "Cancelar".
- Animaciones: pulso del orbe sincronizado con "hablando"; transición de color del timer
  fluida entre tramos; micro-shake o glow rojo suave al llegar al máximo; burbujas de
  transcript entran con fade+slide.

### 4. Evaluando (loading)
- Pantalla de transición mientras se calcula el feedback (unos segundos).
- Spinner o animación de "procesando decisión/analítica". Copy: "Evaluando tu pitch…
  Calculando métricas y generando feedback."
- Animación: algo que evoque analítica/IA trabajando (barras que se acomodan, nodos,
  pulso de datos), sobrio.

### 5. Reporte final (denso pero legible)
- **Hero de score**: anillo/círculo con el número sobre 100, color según rango
  (verde alto, ámbar medio, rojo bajo), nivel de preparación (bajo/medio/alto/
  sobresaliente), target, duración, y un diagnóstico de una línea.
- **Resumen ejecutivo** (párrafo corto).
- **Checklist de requisitos**: duración, incluyó cifra, mencionó SAS, CTA, alineación
  al playbook — cada uno con ✓ / ◐ / ✗.
- **Métricas de habla**: tiles con palabras, palabras/min, muletillas, repeticiones,
  cifras detectadas.
- **Score por criterio**: barras horizontales (ej. claridad 16/20) con comentario.
- **Alertas críticas** (si las hay), **Fortalezas** y **Áreas de mejora** en dos columnas.
- **Frases destacadas**: mejor frase y frase a revisar.
- **Pitch sugerido de 90 s** y **versión ultra corta de 45 s** en cajas destacadas.
- **CTA recomendado** y **próximo foco de entrenamiento**.
- Botones: "Repetir con el mismo target" y "Elegir otro escenario".
- Animaciones: el anillo de score se "llena" animado al aparecer (0 → valor); las barras
  de criterio crecen en secuencia (stagger); tiles con entrada escalonada; scroll suave.

## Detalles de interacción y accesibilidad

- Todo debe verse bien en desktop (uso principal) y degradar a tablet/móvil.
- Contraste AA. Estados de foco visibles. Timer legible a distancia.
- Nada de animación que distraiga durante el pitch (la usuaria está hablando): en la
  pantalla de voz, la animación debe ser calmada y periférica, no protagonista visual
  que robe atención al hablar.
- Las animaciones deben respetar `prefers-reduced-motion`.

## Qué quiero de ti

1. Una propuesta de **sistema visual** (paleta final, tipografía, escala, componentes base).
2. **Mockups de alta fidelidad** de las 5 pantallas (Artifact HTML/CSS responsivo).
3. Las **animaciones descritas ya implementadas** (CSS transitions/keyframes o JS mínimo),
   con `prefers-reduced-motion` respetado.
4. Notas breves de racional de diseño por pantalla.

Prioriza claridad ejecutiva y sensación de herramienta seria de alto desempeño. Evita
lo genérico: que se sienta hecho a la medida de un contexto C-level y de SAS.
