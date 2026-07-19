# Handoff — SAS Pitch Simulator

Fecha: 19 de julio de 2026.
Repo: `/Users/gerardocalambasposada/Documents/Claude_/SAS` (sin remoto git, solo local).

## Qué es este proyecto

Simulador de vocería ejecutiva por voz para SAS Colombia (SmartPR). React +
Vite frontend, Node/Express backend, ElevenLabs Conversational AI para la
voz en tiempo real, Claude Sonnet (vía OpenRouter) para evaluar el pitch al
terminar, Firestore para persistencia. En producción: frontend en Firebase
Hosting, backend en un VPS compartido (Docker + Caddy).

**No dupliques contexto de esto aquí** — está todo en:
- `report.md` (raíz del repo) — arquitectura, qué se construyó, qué está
  verificado, pendientes.
- `git log` (10 commits) — historial completo de cambios, cada uno con
  mensaje descriptivo de qué y por qué.
- `ACCESOS.md` (raíz del repo, **no está en git**) — credenciales reales
  (llaves API, acceso VPS, logins de la app, comandos de deploy). Redactado
  intencionalmente de este documento; ábrelo directo si necesitas operar
  algo.

## Estado al cierre de esta sesión

Todo lo pedido en esta conversación está hecho, verificado y desplegado:

1. Layout responsive mobile completo, portado desde un paquete de diseño de
   referencia (`SmartPR-Simulador-Voceria-Responsive-v2/`, commiteado como
   material de referencia) hacia los componentes React reales — manteniendo
   la paleta vino/crema y la lógica ya existentes (petición explícita del
   usuario), no la paleta azul del paquete original.
2. Se encontraron y corrigieron 3 bugs reales del paquete de referencia en
   el camino (detalle completo en el mensaje de commit
   `516b2e8`): scroll roto por `min-height` en vez de `height` en `.screen`,
   un contenedor heredando un ancho de desktop que angostaba todo en mobile,
   y un choque de CSS que apilaba dos logos que debían ir lado a lado.
3. Dos ajustes de UX pedidos por el usuario ya aplicados: los 3 chips de
   selección de voz en una sola fila en mobile, y el texto de la pregunta
   del agente oculto en la pantalla de conversación en mobile (solo queda
   audio + orbe + timer).
4. Verificado sin regresión en las 7 pantallas de desktop y en el flujo
   completo mobile, con backend real (ElevenLabs conectando de verdad).
5. Deploy hecho y confirmado en producción (bundle servido coincide con el
   build local — aprendimos en esta sesión que Firebase Hosting/el
   navegador puede servir caché vieja tras un deploy; si algo se ve
   desactualizado, sospecha de eso antes que de un bug real).

## Decisiones y lecciones de esta sesión (para no repetir el trabajo)

- El VPS es compartido con otros proyectos (`n8n`, `openclaw`) — el backend
  de este proyecto vive en su propia red Docker aislada
  (`sas-pitch-simulator-net`). Cualquier cambio en el VPS debe verificar
  `docker ps` antes y después para confirmar que esos otros contenedores
  siguen intactos.
- El acceso al VPS es por un usuario Linux dedicado (`sasdeploy`, sin root),
  con llave SSH sin contraseña — nunca se debe volver a compartir la
  contraseña de `root` para operar el día a día.
- El backend no tiene dominio propio, usa `nip.io` (deriva un hostname de la
  IP) para conseguir HTTPS real vía Let's Encrypt sin configurar DNS. Es una
  solución deliberada por tiempo, no un descuido — considerar un dominio
  real más adelante si se quiere ver más profesional.
- El login de la app es un gate del lado del frontend únicamente (no hay
  autenticación real de servidor) — las credenciales viven en código fuente
  (`frontend/src/config.ts`), visibles en el bundle JS público. Es
  aceptable para esta herramienta interna de equipo chico, pero no debe
  tratarse como frontera de seguridad real.
- El backend tiene un token compartido + rate limit (20 req/min por IP)
  como protección básica contra abuso de la URL pública — no es un secreto
  real (viaja en el bundle del frontend), es solo una barrera contra
  descubrimiento accidental/bots.
- El repo de git **no tiene remoto** — vive solo en la máquina del usuario.
  Si la próxima sesión necesita colaborar con más gente, vale la pena
  proponer crear un repo privado en GitHub.

## Qué falta / posibles próximos pasos

Ver la sección final de `report.md` para la lista completa. Los más
relevantes: probar los 3 escenarios (no solo el genérico) con usuarios
reales del equipo, y considerar dominio propio para el backend.

## Suggested skills para la próxima sesión

- **`run`** — si la próxima tarea es "verifica que tal cosa funcione", usar
  este skill para levantar y probar la app real en vez de reinventar el
  flujo de arranque manual.
- **`diagnose`** — si aparece un bug reportado por el usuario (algo "no
  funciona" o "se ve raro"), usar el loop disciplinado de diagnóstico en
  vez de adivinar arreglos.
- **`security-review`** — dado que el login es un gate simple y el backend
  quedó con protección básica (no robusta), vale la pena correr esto antes
  de escalar el proyecto a más usuarios o datos más sensibles.
