# PHASE_06_CONFIG_VERSIONING_PROVENANCE_REPORT

**Proyecto:** SAS Pitch Simulator / Entrenador IA para Voceros
**Fase:** 6 de 15 — CONFIG VERSIONING + PROVENANCE + CONTENT INTEGRATION CONTRACT
**Commit base aprobado (Fases 1–5, cerradas):** `64489f0af83636ee5cb086bf8ee68b46ac6e8d65`
**Código de esta fase:** `15c5476e896acb629bd3eca64d9f6bba20d1b93a`
**Estado:** implementado, testeado y buildeado localmente. **NO desplegado.**

---

## WHAT_CHANGED

Fase 5 separó el engine del contenido de cliente (ENGINE vs CONFIG). Fase 6 resuelve la pregunta que Fase 5 dejó abierta: **¿qué versión exacta de config usó cada sesión, y cómo se activa/despliega una versión nueva sin reinterpretar sesiones en curso?**

- **Nuevo modelo de versión** (`ConfigPackageVersion`, `engine-config/schema.ts`): `draft | active | deprecated`, con un registro explícito — `repositories/configVersions.ts` — que es la ÚNICA autoridad sobre qué versión sirve tráfico nuevo para una organización.
- **`pickVersionDir().sort().reverse()` eliminado por completo** de `engine-config/loader.ts`. `FileConfigPackageLoader.loadPackage(organizationId, version)` ahora exige la versión explícitamente — no existe ningún modo "elígela por mí".
- **`resolveScenarioConfig()` (Fase 5) se dividió en dos funciones distintas** (`engine-config/resolver.ts`): `resolveScenarioConfigForNewSession` (consulta la versión ACTIVE del registro — solo la usa `/session/start`) y `resolveScenarioConfigForVersion` (resuelve una versión PINNEADA exacta, sin tocar el registro — solo la usa `/session/end`).
- **`SessionRecord` gana `config_provenance`** (`types.ts`): `config_version`, `interviewer_profile_id`, `evaluation_framework_id`, `content_source_ids`, `config_hash` — escrito una sola vez en `/session/start`, nunca re-derivado.
- **`/session/end` re-resuelve usando `config_provenance.config_version` pinneado**, nunca la versión activa del momento. Una sesión sin `config_version` (legacy pre-Fase-6) falla cerrado explícitamente — nunca adivina una versión.
- **Content hash determinista** (`engine-config/configHash.ts`, SHA-256 de JSON canónico) — implementado, no dejado como P2. Usado para detectar ediciones en sitio de una versión ya activada (`IMMUTABILITY_POLICY`).
- **Activación atómica** (`activateConfigVersion`, Firestore transaction o su fallback en memoria): valida el paquete, rechaza contenido inválido, rechaza una re-activación cuyo hash cambió, y — si hay una versión ACTIVE previa distinta — la pasa a `deprecated` sin borrarla, todo en una sola escritura atómica.
- **Herramienta CLI reproducible**: `npm run config:validate` / `config:import` / `config:activate` (`backend/scripts/config-{validate,import,activate}.ts`).
- **Nuevo fixture real**: `backend/config-packages/acme-demo/v2/` — una segunda versión REAL del paquete demo (no un mock), usada para probar carga multi-versión contra el filesystem real y para el "TEST DE INTEGRACIÓN CLAVE".

No se tocó: el modelo Organization/Membership/Role/RBAC (Fases 2-3), el session lifecycle state machine (Fase 4), la genericidad ENGINE vs CONFIG en sí (Fase 5 — `EvaluationResult`, `SpeechMetrics`, `detected_requirements` sin cambios), ni el frontend (cero archivos modificados).

---

## VERSION_MODEL

```ts
// engine-config/schema.ts
export const ConfigVersionStatusSchema = z.enum(["draft", "active", "deprecated"]);

export interface ConfigPackageVersion {
  organizationId: string;
  version: string;
  status: "draft" | "active" | "deprecated";
  createdAt: string;
  activatedAt?: string;
  deprecatedAt?: string;
  configHash?: string; // grabado en la primera activación — ver IMMUTABILITY_POLICY
}
```

Vive en `repositories/configVersions.ts` — Firestore-backed (con el mismo fallback en memoria que `repositories/sessions.ts` ya usaba desde Fase 4, gobernado por `PERSISTENCE_DISABLED`), nunca en el filesystem ni en `manifest.json`. Ver STORAGE_DECISION.

---

## VERSION_STATES

| Estado | Puede iniciar sesiones nuevas | Puede resolver sesiones históricas pinneadas a él | Puede volverse `active` |
|---|---|---|---|
| `draft` | No | No (nunca fue active, ninguna sesión real pudo pinnearse a él) | Sí, si el paquete valida |
| `active` | Sí (es la única fuente para `resolveScenarioConfigForNewSession`) | Sí | Ya lo es (no-op idempotente) |
| `deprecated` | No | **Sí** — sus archivos siguen en disco, `resolveScenarioConfigForVersion` los lee igual | Sí (rollback), si el paquete valida y el hash no cambió |

---

## ACTIVE_VERSION_MODEL

**1 organización → máximo 1 versión `active`.** Implementado como un doc "puntero" por organización (`config_versions/{organizationId}` → `{ activeVersion }`) más un doc por versión (`config_versions/{organizationId}/versions/{version}`). `activateConfigVersion` lee AMBOS dentro de la misma transacción antes de escribir nada: si había una versión active distinta, la deprecia en la misma escritura atómica que activa la nueva. No hay canales, A/B ni staged rollout — explícitamente fuera de alcance de esta fase (ver NO_HACER del prompt).

---

## IMMUTABILITY_POLICY

Una versión que ya fue activada al menos una vez se considera inmutable. Esta fase **no** implementa permisos/editor UI que impidan editar los archivos en disco a mano (el prompt lo marcó explícitamente como no obligatorio) — pero SÍ implementa la única enforcement mecánica posible dado ese alcance: **el content hash**.

- `activateConfigVersion` recuerda el `configHash` con el que una versión se activó por primera vez.
- Si se vuelve a llamar sobre la MISMA versión y el hash recién calculado (desde los archivos reales en disco, en el momento de la llamada) **no coincide**, la activación se rechaza con `outcome: "immutability_violation"` — el registro no se toca.
- Si el hash coincide (nada cambió), la re-activación es un no-op idempotente inofensivo.
- Una versión con contenido genuinamente distinto debe publicarse como una versión NUEVA (`v2`, `v3`, ...), nunca reescribiendo `v1` en sitio — exactamente la regla `sas-colombia/v1 → NO editar en sitio; v1 → v2`.

Ver CONTENT_HASH_DECISION para el diseño del hash en sí, y KNOWN_LIMITATIONS para lo que esto NO cubre (drift detection continuo en cada resolución, no solo en activación).

---

## PROVENANCE_MODEL

```ts
// types.ts — SessionRecord
config_provenance?: {
  config_version: string;
  interviewer_profile_id: string;
  evaluation_framework_id: string;
  content_source_ids: string[];
  config_hash: string;
};
```

**Decisión explícita sobre duplicación:** `scenario_id` NO se repite dentro de `config_provenance` — `SessionRecord.scenario_id` (campo canónico desde Fase 5) ya vive en la raíz del mismo documento; duplicarlo ahí habría sido exactamente la "duplicación innecesaria" que el prompt pidió evitar. `config_provenance` contiene solo lo que Fase 6 agrega: la versión pinneada y las referencias que esa versión resolvió (perfil, framework, content sources) más el hash de contenido. Con `scenario_id` (raíz) + `config_provenance` (este bloque), una sesión histórica puede responder exactamente qué organización, qué config package, qué versión, qué scenario, qué interviewer profile, qué evaluation framework y qué content sources usó — sin volver a resolver nada, y sin guardar el paquete completo.

**No se persiste el paquete completo** — solo ids + hash, como pidió explícitamente el prompt ("no persistas todo el paquete... salvo que exista una razón fuerte").

---

## SESSION_PINNING

`config_provenance` se escribe UNA VEZ, en `/session/start`, a partir de `ResolvedScenarioConfig.configVersion`/`.configHash` (que a su vez vienen de `resolveScenarioConfigForNewSession`, que consultó el registro en ESE momento). `/session/end` nunca vuelve a llamar a `resolveScenarioConfigForNewSession` ni a nada que consulte "cuál es la versión active ahora" — llama exclusivamente a `resolveScenarioConfigForVersion` con el `config_version` ya persistido. Esto hace estructuralmente imposible el escenario que el prompt prohibió:

```
/session/start usa v1 (persiste config_version: "v1")
↓
alguien activa v2
↓
/session/end lee config_provenance.config_version ("v1", inmutable) → resuelve v1 exactamente
```

Ver el TEST_DE_INTEGRACIÓN_CLAVE abajo para la prueba concreta de esto.

---

## SESSION_START_FLOW

```
POST /session/start
  organizationId (de req.appContext, nunca del body) + scenarioId (de target_mode, wire-compat)
  → resolveScenarioConfigForNewSession({ organizationId, scenarioId })
      → registry.resolveActiveVersion(organizationId)
          null → { outcome: "no_config_for_organization" } → 503
      → loader.loadPackage(organizationId, activeVersion)
          inválido → { outcome: "no_config_for_organization" } → 503
      → busca scenarioId dentro de ESA versión
          no existe → { outcome: "scenario_not_found" } → 400
      → { outcome: "resolved", config: ResolvedScenarioConfig } (con configVersion/configHash)
  → getSignedUrl(resolved, ...) (ElevenLabs, sin cambios de Fase 5)
  → createSession({ ...SessionRecord, config_provenance: { config_version: resolved.configVersion, ... } })
```

---

## SESSION_END_FLOW

```
POST /session/end
  → claimSessionForEvaluation(...) (Fase 4, sin cambios)
  → claim.session.config_provenance?.config_version
      undefined → LEGACY_SESSION_POLICY: markEvaluationFailed("LEGACY_CONFIG_VERSION_UNKNOWN") → 503
                  (nunca se llama a resolveScenarioConfigForVersion — no hay qué resolver)
  → resolveScenarioConfigForVersion({ organizationId, scenarioId, configVersion: <pinneado> })
      inválido/no existe → { outcome: "unknown_config_version" } →
        markEvaluationFailed("CONFIG_VERSION_RESOLUTION_FAILED") → 503
      scenario no existe EN ESA VERSIÓN → { outcome: "scenario_not_found" } → mismo camino de error
      → { outcome: "resolved", config } (exactamente la versión pinneada, sin importar qué esté active hoy)
  → evaluatePitch({ resolved, ... }) → persistCompletedResult(...) (Fase 4, sin cambios)
```

---

## RESOLUTION_API

Deliberadamente DOS funciones, no una con un parámetro opcional — ver el comentario al inicio de `resolver.ts`:

```ts
resolveScenarioConfigForNewSession(
  { organizationId, scenarioId },
  { loader?, registry? }
): Promise<ResolveForNewSessionResult>
// "resolved" | "no_config_for_organization" | "scenario_not_found"
// ES LA ÚNICA que consulta ConfigVersionRegistry.resolveActiveVersion().

resolveScenarioConfigForVersion(
  { organizationId, scenarioId, configVersion },
  { loader? }
): Promise<ResolveForVersionResult>
// "resolved" | "unknown_config_version" | "scenario_not_found"
// NO tiene dependencia del registro en absoluto — sus archivos siguen
// en disco sin importar el status actual (active/deprecated) en el registro.
```

Cada función tiene su PROPIO tipo de resultado (no una unión compartida) — así ningún caller tiene que manejar un outcome que estructuralmente no puede ocurrir en ese camino.

---

## ACTIVATION_FLOW

```ts
activateConfigVersion(organizationId, version, loader?)
  1. loader.loadPackage(organizationId, version)   // SIEMPRE re-valida, nunca confía en el registro
     inválido → { outcome: "invalid_package", errors }  — NO ACTIVAR CONFIG INVÁLIDA
  2. compara result.hash contra el configHash YA REGISTRADO para esa versión (si existe)
     distinto → { outcome: "immutability_violation", recordedHash, currentHash }
  3. transacción atómica (Firestore) / operación en memoria (dev):
     - lee el puntero org → versión active actual
     - si existe y es distinta → la marca deprecated (deprecatedAt = ahora)
     - marca `version` como active (activatedAt = ahora, configHash = result.hash)
     - actualiza el puntero org → version
  4. { outcome: "activated", record, previousActiveVersion }
```

Auto-registra un `draft` si la versión nunca se registró — una sola llamada puede ir de "nada" a "active" (conveniencia de `config:import --activate`); `registerDraftVersion` por sí sola sigue siendo el flujo de dos pasos más seguro (draft, QA, activar después).

---

## DEPRECATION_FLOW

```
v1 active
↓ activateConfigVersion(org, "v2")
v2 active, v1 deprecated (deprecatedAt grabado, NO eliminado)
↓
resolveActiveVersion(org) → "v2"   (nuevas sesiones)
resolveScenarioConfigForVersion(org, scenario, "v1") → sigue resolviendo   (sesiones históricas)
```

Probado explícitamente en `configVersions.test.ts` y `resolver.test.ts` (ver TESTS_ADDED).

---

## STORAGE_DECISION

**Híbrida — exactamente la que el prompt sugirió como ejemplo de no sobrearquitectar:**

- **Contenido del paquete** (`manifest.json`, `client.json`, `scenarios/`, `interviewer-profiles/`, `evaluation-frameworks/`, `content/`) sigue en `backend/config-packages/<organizationId>/<version>/`, versionado en git — sin cambios de Fase 5. Ventajas de Opción A (simple, auditable, historial de PR, rollback fácil vía git) sin tocarlas.
- **El puntero de versión activa y el estado de cada versión** (`draft`/`active`/`deprecated`, timestamps, hash) viven en Firestore (`repositories/configVersions.ts`), con el mismo fallback en memoria que `repositories/sessions.ts` ya establecía para `PERSISTENCE_DISABLED`. Ventaja de Opción B (activar una versión es un cambio de dato, no un deploy) sin mover el contenido en sí.

Esto deja el camino preparado para Fase 12 (gestión vía UI) sin construirla ahora: una futura UI de activación solo necesitaría llamar `activateConfigVersion`, exactamente como el CLI ya lo hace.

---

## CONTENT_INTEGRATION_CONTRACT

```
FUENTES DEL CLIENTE
↓
VOCERIA_CLIENT_CONTENT_TEMPLATE.zip completado por un humano
↓
validación humana (checklist del propio README del template)
↓
transformación a config-package (persona/agente — ver mapping abajo)
↓
npm run config:validate -- <path>        (schema + semantic validation, sin escribir nada)
↓
npm run config:import -- <path>          (registra draft en el registry)
↓
QA manual sobre el draft
↓
npm run config:import -- <path> --activate   (o config:activate por separado)
↓
nuevas sesiones usan esa versión; sesiones en curso con la versión anterior no se ven afectadas
```

**Regla explícita del prompt, seguida al pie de la letra:** `VOCERIA_CLIENT_CONTENT_TEMPLATE.zip` es el contrato HUMANO; `engine-config/schema.ts` es el contrato EJECUTABLE. Si divergen, se reporta la divergencia — nunca se reconcilia en silencio. Ver la sección siguiente para las divergencias reales encontradas.

---

## HUMAN_TEMPLATE_TO_CONFIG_MAPPING

El ZIP (`~/Downloads/VOCERIA_CLIENT_CONTENT_TEMPLATE.zip`, inspeccionado en `/tmp`, nunca copiado ciegamente al repo) contiene: `README.md`, `CONTENT_PACKAGE_SPEC.md`, `MACHINE_READABLE_SPEC.json`, un esqueleto (`manifest.json`, `client.json`, `content/*.json`, `interviewer-profiles/*.json`, `scenarios/*.json`, `evaluation-frameworks/*.json`) y `examples/EXAMPLE_FILLED_PACKAGE/` (un paquete ficticio completo) + `examples/CONTENT_MAPPING_EXAMPLE.md`.

**Mapeo archivo → entidad del schema (1:1, sin transformación):**

| Archivo del template | Entidad ejecutable | Notas |
|---|---|---|
| `manifest.json` | `ManifestSchema` | Mismos campos exactos: `organizationId, version, status, interviewerProfiles[], scenarios[], evaluationFrameworks[], contentSources[]` |
| `client.json` | `ClientConfigSchema` | Mismos campos exactos |
| `content/company-context.json`, `key-messages.json`, `facts.json`, `restrictions.json`, `faq.json`, `playbook.json` | `ContentSourceSchema` (una instancia cada uno) | El campo `type` del template mapea 1:1 a `ContentSourceTypeSchema` (`company_context \| key_messages \| facts \| restrictions \| faq \| playbook`) |
| `interviewer-profiles/*.json` | `InterviewerProfileSchema` | Mismos campos exactos, incluido `voice.slot` restringido a `male\|female\|random` |
| `scenarios/*.json` | `ScenarioSchema` | Mismos campos exactos, composición por referencia (`interviewerProfileId`, `evaluationFrameworkId`, `contentSourceIds[]`) |
| `evaluation-frameworks/*.json` | `EvaluationFrameworkSchema` | Ver divergencia de `requirements` abajo |

**PRUEBA CONCRETA (no solo documentada — ejecutada):** se copió `examples/EXAMPLE_FILLED_PACKAGE/` a una carpeta temporal reestructurada como `<root>/acme-demo-template-example/v1/` (renombrando `organizationId` en `manifest.json`/`client.json` para que coincida con la carpeta — sin tocar ningún otro contenido) y se corrió `npm run config:validate -- <esa-carpeta>`:

```
organization: acme-demo-template-example
version: v1
scenarios: 2
interviewers: 2
frameworks: 1
contentSources: 6
configHash: 69f4c190fb88ba46717dbee1727213e48a6d574f88588f2f70cd2a348b33a291
validation: PASS
```

El contenido de ejemplo del template pasa la validación estructural + semántica real sin ninguna transformación de campos — la única intervención fue el renombrado de `organizationId` para que coincidiera con la carpeta (una regla de nombres, no de contenido). No se dejó esta carpeta en el repo (es contenido ficticio del template, no un fixture propio del producto) — el experimento se corrió y se descartó; el resultado queda documentado aquí como evidencia.

**Divergencias reales encontradas (reportadas, NO reconciliadas en silencio):**

1. **`requirements[]` no existe en el template.** El schema ejecutable (extendido en la ronda de fixes de Fase 5) permite que un `EvaluationFramework` declare `requirements: Array<{id, description}>` — el mecanismo genérico para necesidades tipo "mencionar la marca" o "incluir un dato verificable" sin campos client-specific en `EvaluationResult`. El template's `CONTENT_PACKAGE_SPEC.md` (sección 10, "Requisitos específicos sin tocar el engine") describe exactamente ese tipo de necesidad pero solo menciona `criteria/observableRules/mustReward/mustPenalize/evaluationInstructions` como destino — no menciona `requirements[]`. Es **compatible** (el campo es opcional, default `[]` — un paquete del template sin `requirements` valida igual), pero un autor humano siguiendo el template al pie de la letra no se enteraría de que existe esta opción más estructurada. **Decisión que queda pendiente, explícita, no tomada aquí:** actualizar el template (agregar una sección 10.1 sobre `requirements[]`) es un cambio al ZIP humano, fuera del repo de código — se reporta, no se ejecuta desde esta sesión.
2. **`manifest.json`'s `status` de ejemplo es `"active"`.** El template no sabe (ni debería saber) que desde esta fase `manifest.status` dejó de ser la autoridad — ver CONTENT_PACKAGE_STATUS más abajo. Un humano completando el template podría razonablemente asumir que poner `"active"` ahí activa el paquete. No es un error de schema (el campo sigue siendo válido), es un desalineamiento de expectativas. Reportado; no se editó el ZIP.

---

## CONTENT_PACKAGE_STATUS

`manifest.status` (`"active" | "deprecated"`, Fase 5) se mantiene en el schema por compatibilidad estructural, pero **ya no gobierna nada** — es texto informativo dentro del paquete, no consultado por `loader.ts`, `resolver.ts` ni `activateConfigVersion`. La única autoridad sobre qué versión está activa es el registro (`repositories/configVersions.ts`). Esto se documentó explícitamente en el propio `schema.ts` (comentario junto a `ManifestSchema`) para que no queden dos fuentes de verdad contradictorias — exactamente la instrucción del prompt.

---

## VALIDATION_TOOLING

```bash
npm run config:validate -- <path-a-carpeta-de-version>
```

Puramente de lectura — no toca Firestore, no requiere credenciales. Usa el mismo `FileConfigPackageLoader` que corre en producción, con un `root` reconstruido desde `<path>` para que funcione con CUALQUIER carpeta que siga la convención `<root>/<organizationId>/<version>/`, dentro o fuera del repo (por ejemplo una extracción temporal del ZIP transformado). Verifica: JSON válido, schema Zod (los 6 esquemas), referencias cruzadas, ids duplicados, pesos de criterios, `requirements`, manifest completeness, `organizationId`/`version` consistentes con la ruta — exactamente la lista pedida. Devuelve `PASS`/`FAIL` + código de salida (0/1) accionable desde CI.

```bash
npm run config:import -- <path> [--dry-run] [--activate]
npm run config:activate -- <organizationId> <version>
```

Ambos re-validan siempre antes de escribir cualquier cosa.

---

## DRY_RUN_FLOW

`config:validate` y `config:import -- <path> --dry-run` imprimen exactamente el formato pedido:

```
organization: acme-demo
version: v1
scenarios: 1
interviewers: 1
frameworks: 1
contentSources: 1
configHash: 9a1530b49ebd67f9e7559aff07007fb7367df27bcf583ad783f150192fee5b65
validation: PASS
```

(salida real, capturada corriendo la herramienta contra `backend/config-packages/acme-demo/v1` — ver TEST_RESULTS. Hash actualizado en el `PASS_WITH_FIXES_ADDENDUM` tras excluir `manifest.status` del cálculo — ver CONTENT_HASH_DECISION.) `--dry-run` no llama a `registerDraftVersion` ni a `activateConfigVersion` bajo ninguna condición — la rama de escritura está DESPUÉS del `if (dryRun) { ...; process.exit(0); }` en el código fuente, no gateada por una condición que pueda evaluarse mal.

---

## CONTENT_HASH_DECISION

**Implementado, no dejado como P2.** `engine-config/configHash.ts`: `computeConfigHash(pkg)` = SHA-256 de `canonicalJSON(pkg)`, donde `canonicalJSON` ordena recursivamente las keys de cada objeto (para que el orden de escritura en el `.json` fuente nunca cambie el hash) y preserva el orden de los arrays (el loader ya lee directorios en orden determinista por nombre de archivo — `readJsonDir`'s `.sort()` — así que el orden de arrays también es estable y, además, semánticamente significativo: el orden de `criteria` importa). Se hashea el paquete YA VALIDADO Y PARSEADO por Zod (con defaults aplicados), nunca los bytes crudos del archivo — así reformatear un `.json` (espacios, orden de keys) nunca cambia el hash, solo un cambio de contenido real lo hace.

**`manifest.status` EXCLUIDO del hash canónico (decisión explícita, ver PASS_WITH_FIXES_ADDENDUM más abajo).**

Usos concretos, no solo un campo decorativo:
1. **IMMUTABILITY_POLICY**: rechaza reactivar una versión cuyo contenido cambió desde su primera activación.
2. **PROVENANCE_MODEL**: cada sesión guarda el hash de la config exacta que usó (`config_provenance.config_hash`), auditable independientemente del texto plano de los archivos.
3. **CONFIG HASH COMO PRECONDICIÓN REAL** (agregado en el `PASS_WITH_FIXES_ADDENDUM`): `/session/start` y `/session/end` comparan el hash resuelto contra el hash registrado/pinneado — ya no basta con que el NOMBRE de versión resuelva.

**Explícitamente NO es sustituto del version id** — sigue siendo `config_version` (no el hash) lo que se resuelve, se pinnea y aparece en logs/URLs; el hash es evidencia de integridad debajo de ese id, no el identificador en sí.

---

## LEGACY_SESSION_POLICY

Sesiones creadas antes de esta fase (todas las de Fases 1–5, incluidas las ~68 sesiones legacy mencionadas en fases anteriores) no tienen `config_provenance`. **No se migran** — el prompt lo prohibió explícitamente ("no migres automáticamente... no inventar una versión histórica"). `/session/end` sobre una de estas sesiones falla cerrado con 503 y categoría `LEGACY_CONFIG_VERSION_UNKNOWN`, sin intentar `resolveScenarioConfigForVersion` (no hay qué resolver). Cualquier sesión así que quedó `in_progress`/`evaluating` sin completar seguirá sin poder completarse hasta Fase 10 (migración explícita, fuera de esta fase). Documentado, no una omisión.

---

## SECURITY_IMPACT

- Ningún cambio al modelo de autenticación/autorización (Fases 1-3) ni al tenant isolation — `organizationId` sigue viniendo exclusivamente de `req.appContext`, nunca del body, en ambos endpoints.
- El registro de versiones es tenant-scoped por construcción (`config_versions/{organizationId}/...`) — una organización nunca puede activar ni leer la versión de otra; probado (`configVersions.test.ts`: "dos organizaciones activando v1 no colisionan").
- `/session/end` ahora tiene un camino de fallo NUEVO (legacy provenance) que antes no existía — es una restricción más estricta (fail-closed), no una superficie nueva de ataque.
- Los CLI (`config:import`/`config:activate`) requieren `initFirebase()` + `isAuthReady()` (las mismas credenciales de servidor que cualquier otro script en `backend/scripts/`) — no son invocables sin acceso al service account, igual que `mark-abandoned-sessions.ts`.

---

## MULTITENANT_IMPACT

Cada organización tiene su propio puntero de versión activa y su propio conjunto de versiones — activar `v2` para `sas-colombia` no afecta en absoluto a `acme-demo` ni a ninguna otra organización (probado explícitamente). Dos organizaciones pueden reutilizar el mismo identificador de versión (`"v1"`) sin colisión, igual que ya podían reutilizar `scenarioId` desde Fase 5.

---

## FILES_CHANGED

**Nuevo**
- `backend/src/engine-config/configHash.ts` — `canonicalJSON`, `computeConfigHash`.
- `backend/src/repositories/configVersions.ts` — el registro de versiones (Firestore + fallback en memoria), `registerDraftVersion`, `activateConfigVersion`, `resolveActiveVersion`, `getVersion`, `listVersions`.
- `backend/src/repositories/configVersions.test.ts` — 11 tests.
- `backend/scripts/config-validate.ts`, `config-import.ts`, `config-activate.ts` — CLI tooling.
- `backend/config-packages/acme-demo/v2/**` — segunda versión REAL del paquete demo (manifest, client, interviewer-profiles, content copiados de v1 sin cambios; `scenarios/press-followup.json` nuevo, exclusivo de v2; `evaluation-frameworks/press-generic-v1.json` con `evaluationInstructions` deliberadamente distinto de v1, para que el hash difiera de forma real).

**Modificado**
- `backend/src/engine-config/schema.ts` — `ConfigVersionStatusSchema`/`ConfigPackageVersion`; `ResolvedScenarioConfig` gana `configVersion`/`configHash`; comentario de no-autoridad en `ManifestSchema.status`.
- `backend/src/engine-config/loader.ts` — `loadPackage(organizationId, version)` (versión explícita, ya no auto-elegida); `pickVersionDir` eliminado; `listVersionDirs` nuevo (solo tooling, nunca resolución); cross-check `manifest.version` vs. versión solicitada; hash en el resultado.
- `backend/src/engine-config/resolver.ts` — reescrito: `resolveScenarioConfigForNewSession` + `resolveScenarioConfigForVersion` reemplazan `resolveScenarioConfig`; `listScenarioIds` eliminado (dead code, sin caller).
- `backend/src/types.ts` — `SessionRecord.config_provenance`.
- `backend/src/routes.ts` — `/session/start` persiste `config_provenance`; `/session/end` resuelve por versión pinneada, con fail-closed explícito para provenance ausente/desconocida.
- `backend/package.json` — 3 scripts nuevos (`config:validate`, `config:import`, `config:activate`).
- Tests existentes actualizados a la nueva firma de `loadPackage`/las nuevas funciones del resolver: `engine-config/loader.test.ts`, `engine-config/resolver.test.ts`, `engine/promptBuilder.test.ts`, `engine/evaluatorPromptBuilder.test.ts`, `services/evaluator.test.ts`, `services/elevenlabs.test.ts`, `routes.test.ts`.

---

## TESTS_ADDED

**`repositories/configVersions.test.ts` (11, archivo nuevo):** crea draft; idempotencia (no downgrade); `resolveActiveVersion`/`getVersion` devuelven null sin registro; draft nunca es active; NO ACTIVAR CONFIG INVÁLIDA; activa una versión nunca registrada (draft+activate en un paso); UNA SOLA ACTIVE VERSION (activar v2 deprecia v1 sin borrarlo); rollback a una versión deprecated con contenido sin cambios; IMMUTABILITY_POLICY (rechaza reactivar con hash distinto, y el registro queda intacto); reactivación idéntica es no-op; dos organizaciones no colisionan.

**`engine-config/resolver.test.ts` (10, +4 sobre los 6 de Fase 5):** `resolveScenarioConfigForNewSession` resuelve por versión ACTIVE del registro (nunca por directorio); `no_config_for_organization` sin versión active; `scenario_not_found`; dos organizaciones sin colisión; **recoge una versión recién activada** (antes/después de cambiar el registro). `resolveScenarioConfigForVersion` resuelve exactamente la versión pinneada ignorando el registro; un scenario que existe en v2 pero no en v1 no es alcanzable desde un pin a v1; `unknown_config_version` para una versión que no existe; sigue resolviendo aunque ya no sea active (deprecation); no permite cruzar organizaciones por scenarioId.

**`engine-config/loader.test.ts` (18, +6 sobre los 12 previos):** contra los paquetes reales — sas-colombia v1, acme-demo v1 (con aserción de hash con formato SHA-256), **acme-demo v2 real** (con el scenario exclusivo `press-followup` probando "existe en v2 pero no en v1"), organización sin paquete, versión que no existe bajo una organización real; determinismo del hash (misma carga → mismo hash) y diferencia real entre v1/v2; cross-check de `manifest.version` contra archivos temporales reales escritos a disco (acepta cuando coincide, rechaza cuando no).

**`routes.test.ts` (56, +5 sobre los 51 previos, dentro de un nuevo `describe("Phase 6: CONFIG VERSIONING + PROVENANCE")`):**
- **EL TEST DE INTEGRACIÓN CLAVE**: `/session/start` con org-1 (v1 mockeado como active) crea la sesión S con `config_provenance.config_version === "v1"`; `/session/end` de S resuelve `configVersion: "v1"` y el `evaluatePitch` recibido usa `evaluationFramework.id === "f1-v1"` (nunca `"f1-v2"`); una SEGUNDA sesión iniciada después (con el mock de "nueva sesión" devolviendo v2) queda pinneada a `"v2"` — probando en un solo test start→activate-conceptual→end→start2 exactamente el escenario obligatorio del prompt.
- `config_provenance` persistido contiene exactamente `config_version`/`interviewer_profile_id`/`evaluation_framework_id`/`content_source_ids`/`config_hash`.
- LEGACY_SESSION_POLICY: una sesión sin `config_provenance` en absoluto → `/session/end` 503, `resolveScenarioConfigForVersion` NUNCA se llama, status queda `evaluation_failed` con `failure_reason: "LEGACY_CONFIG_VERSION_UNKNOWN"`.
- `config_version` desconocida (el mock devuelve `unknown_config_version`) → 503, fail-closed.
- DEPRECATION_FLOW a nivel HTTP: una sesión con su versión ya no-active sigue completándose con éxito.

Todos los tests de Fases 1–5 se mantienen verdes sin cambiar sus expectativas de comportamiento (solo se actualizaron fixtures a la nueva forma de `ResolvedScenarioConfig`/`loadPackage`).

---

## TEST_RESULTS

```
$ npm test
backend:  Test Files  17 passed (17) | Tests  213 passed (213)
frontend: Test Files   2 passed (2)  | Tests    8 passed (8)
```

(213 backend = 187 de Fases 1–5 + 26 nuevas: 11 en `repositories/configVersions.test.ts` + 4 en `engine-config/resolver.test.ts` + 6 en `engine-config/loader.test.ts` + 5 en `routes.test.ts`.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores (cero archivos de frontend tocados)
```

**Herramienta CLI ejecutada de verdad (no solo descrita) contra los fixtures reales:**

```
$ npm run config:validate -- backend/config-packages/acme-demo/v1
organization: acme-demo
version: v1
scenarios: 1
interviewers: 1
frameworks: 1
contentSources: 1
configHash: aad1518ca72cf6967c98ab49901f5fe8df2d0610f8b7349c66d18114828cb0de
validation: PASS

$ npm run config:validate -- backend/config-packages/acme-demo/v2
organization: acme-demo
version: v2
scenarios: 2
interviewers: 1
frameworks: 1
contentSources: 1
configHash: f7e2d8e812b7745463665e65d67ef82777d50d533f103add8d53314059640395
validation: PASS
```

(Hashes distintos entre v1/v2, confirmando que el content hash captura el cambio real de contenido — no solo la etiqueta de versión. **Estos valores de hash específicos cambiaron en el `PASS_WITH_FIXES_ADDENDUM` de abajo** al excluir `manifest.status` del cálculo — el resto de esta sección, incluidos los conteos de tests, es la instantánea de la entrega original de Fase 6, antes del fix.)

**`config:import`/`config:activate` NO se corrieron contra Firestore real en esta sesión** — ver KNOWN_LIMITATIONS/OPEN_ITEMS: el proyecto tiene credenciales reales configuradas (`FIREBASE_SERVICE_ACCOUNT_PATH` apunta a un service account real de `smartpr-pitch-agent`), y escribir ahí sin pedir autorización explícita habría sido una acción con efecto en un sistema compartido — se evitó deliberadamente. Su lógica SÍ está completamente cubierta por `configVersions.test.ts` (11 tests, sin Firestore real, vía el fallback en memoria) — los scripts CLI son wrappers delgados sobre esas mismas funciones ya probadas.

---

## KNOWN_LIMITATIONS

- ~~No hay enforcement de inmutabilidad en cada resolución, solo en (re)activación~~ — **corregido en el `PASS_WITH_FIXES_ADDENDUM` de abajo**: `/session/start` y `/session/end` ahora comparan el hash resuelto contra el hash registrado/pinneado en cada resolución, no solo en activación. Ver VERSION_PINNING_PLUS_HASH_ENFORCEMENT.
- **`manifest.status` sigue siendo un campo válido pero inerte** — no se eliminó del schema (habría sido tocar el núcleo de `schema.ts` innecesariamente para un campo ya opcional/inofensivo), pero un operador que lo edite esperando que gobierne algo se llevará una sorpresa. Documentado explícitamente (CONTENT_PACKAGE_STATUS) en vez de dejarlo como trampa silenciosa.
- **No se implementó ningún mecanismo de "no borrar una versión deprecated con sesiones que la referencian"** de forma activa — no existe ninguna operación de borrado de versión en todo el sistema todavía, así que no hay nada que enforcear contra eso hoy. Si Fase 7+ agrega un "delete version", esa operación deberá consultar sesiones antes de proceder.
- **El template `VOCERIA_CLIENT_CONTENT_TEMPLATE.zip` no menciona `requirements[]`** (ver HUMAN_TEMPLATE_TO_CONFIG_MAPPING) — compatible pero desalineado; actualizar el ZIP queda pendiente, consciente, fuera de esta sesión.
- **`config:import`/`config:activate` no se ejecutaron contra Firestore real** en esta sesión (ver TEST_RESULTS) — quedan verificados por unit tests con fallback en memoria, no por una corrida end-to-end contra el proyecto real.
- **Sin caché de `loadPackage`** (ya documentado desde Fase 5) — cada resolución welee y valida los JSON desde disco; con versionado explícito esto es aún más barato de cachear por `(organizationId, version)` ya que el resultado de una versión activada nunca cambia (justamente por IMMUTABILITY_POLICY) — candidato natural de optimización futura.

---

## MIGRATION_NOTES

- **Nada de esto está desplegado.** Producción sigue sirviendo Fase 5.
- **Antes de desplegar esta fase, CADA organización con contenido real (`sas-colombia`, y `acme-demo` si se decide llevarlo a producción) necesita una activación explícita** — `npm run config:import -- backend/config-packages/sas-colombia/v1 --activate` (y lo mismo para `acme-demo/v1`). Sin este paso, `/session/start` devolverá 503 (`no_config_for_organization`) para TODA organización, incluso con archivos válidos en disco — es un cambio de comportamiento deliberado respecto a Fase 5 (que auto-elegía la única versión en disco); ahora la activación es siempre explícita, nunca implícita.
- **El registro de versiones es nuevo y empieza vacío** tanto en Firestore real como en el fallback de desarrollo — no hay backfill automático ni bootstrap silencioso (habría sido exactamente el tipo de autoridad implícita que esta fase elimina).
- **Sesiones en curso al momento del deploy** (creadas bajo Fase 5, sin `config_provenance`) no podrán completarse vía `/session/end` después de desplegar esta fase — caerán en LEGACY_SESSION_POLICY (503). Si en el momento real del deploy hay sesiones `in_progress`/`evaluating`, considerar una ventana de mantenimiento o aceptar la pérdida de esas sesiones puntuales — no se agregó ninguna compatibilidad retroactiva a propósito (ver LEGACY_SESSION_POLICY).
- **`backend/config-packages/acme-demo/v2/`** viaja con el código de esta fase pero no se activa por sí sola — como cualquier versión, requiere `config:activate` explícito.

---

## OPEN_ITEMS

- [ ] Revisar y aprobar este reporte.
- [ ] Ejecutar `config:import --activate` contra Firestore real para `sas-colombia/v1` y decidir sobre `acme-demo/v1` — requiere autorización explícita antes de escribir en el proyecto real (`smartpr-pitch-agent`), no se hizo desde esta sesión.
- [ ] Decidir si actualizar `VOCERIA_CLIENT_CONTENT_TEMPLATE.zip` para documentar `requirements[]` (divergencia reportada en HUMAN_TEMPLATE_TO_CONFIG_MAPPING).
- [ ] Fase 7: hardening de providers, observability, rate limiting — explícitamente no tocado aquí.
- [ ] Fase 10: migración de sesiones legacy (incluidas las que ahora caen bajo LEGACY_CONFIG_VERSION_UNKNOWN además de las ~68 previas).
- [ ] Fase 12: UI de gestión de config (draft/QA/activate) sobre las mismas funciones (`activateConfigVersion`, etc.) que el CLI ya expone — sin rediseño de arquitectura.
- [ ] Onboarding real de Novo: usar el flujo `CONTENT_INTEGRATION_CONTRACT` documentado aquí con contenido real, produciendo `novo/v1` — la meta explícita de esta fase era dejar el flujo listo, no ejecutarlo con contenido real todavía.
- [x] ~~Evaluar drift-detection de hash en cada resolución (no solo en activación)~~ — hecho en el `PASS_WITH_FIXES_ADDENDUM` de abajo, no quedó pendiente.

---

**Commit de código de esta fase:** `15c5476e896acb629bd3eca64d9f6bba20d1b93a`
**Este reporte:** commiteado por separado, después del código.

---

## PASS_WITH_FIXES_ADDENDUM

**Veredicto de revisión:** `PASS_WITH_FIXES`. Arquitectura general aprobada — version registry, storage híbrido, CLI, lifecycle sin rehacer. **Un único fix estructural obligatorio: el content hash tenía que ser una precondición real, no solo un dato guardado.** No se avanzó a Fase 7. No se tocó Firestore real.
**Commit del fix (código):** `5a60fd3176a03a1a2f23008a2f7e43a8c28dd09a`

### VERSION_PINNING_PLUS_HASH_ENFORCEMENT

**`version pinning + hash enforcement = exact content provenance.`**

Pinnear una sesión al NOMBRE de una versión (`config_version: "v1"`) sin verificar que el CONTENIDO de esa versión siga siendo el mismo deja un hueco: `v1` es un identificador estable por diseño (nunca cambia), pero nada impedía que sus archivos cambiaran por debajo de ese nombre entre el inicio y el fin de una sesión, o entre dos sesiones distintas que ambas creen estar usando "v1". La entrega original de esta fase guardaba `config_hash` en la provenance pero nunca lo comparaba contra nada — era un dato de auditoría pasivo, no una precondición. Con este fix:

- **`/session/end`** ya no confía en que el `config_version` resuelto correctamente implique contenido correcto — compara explícitamente `resolved.configHash` contra `claim.session.config_provenance.config_hash` (el hash grabado en el momento exacto en que la sesión empezó) ANTES de tocar el evaluador.
- **`/session/start`** ya no confía en que el registry diga "v1 is active" sin verificar que "v1" en disco siga siendo lo que el registry registró — compara el hash grabado en la activación contra el hash recién calculado de los archivos reales.
- Juntas, estas dos comparaciones cierran el hueco: un `config_version` nunca vuelve a ser suficiente por sí solo — su CONTENIDO exacto (el hash) es ahora parte de la precondición de resolución en ambos extremos del ciclo de vida de una sesión. Esto es lo que "exact content provenance" significa concretamente en este sistema: no solo "qué versión", sino "qué versión, con qué contenido exacto, verificado en el momento del uso".

### 1. `/session/end` — CONFIG_PROVENANCE_HASH_MISMATCH

`routes.ts`, inmediatamente después de que `resolveScenarioConfigForVersion` devuelve `resolved`, antes de `computeMetrics`/`evaluatePitch`:

```ts
if (resolved.configHash !== provenance.config_hash) {
  await markEvaluationFailed(session_id, "CONFIG_PROVENANCE_HASH_MISMATCH").catch(() => {});
  return res.status(503).json({ error: "No se pudo evaluar la sesión. Intenta de nuevo más tarde." });
}
```

- **Fail closed**: `evaluatePitch` nunca se llama en este camino — el `return` ocurre antes.
- **`failure_reason` seguro**: `"CONFIG_PROVENANCE_HASH_MISMATCH"` es una categoría fija, nunca el hash real ni ninguna ruta de archivo — coherente con el resto de `FAILURE_REASON_TAXONOMY` (Fase 4).
- **Nunca re-pinnea ni sustituye el hash**: `markEvaluationFailed` solo escribe `status`/`failure_reason` (ver `repositories/sessions.ts`, sin cambios) — `config_provenance` de la sesión queda exactamente como se escribió en `/session/start`, para siempre. La provenance persistida es la autoridad histórica, tal como pidió la revisión — nunca se actualiza para "coincidir" con lo que se encontró después.
- **Respuesta externa genérica**: el cliente recibe el mismo 503 genérico que cualquier otro fallo de evaluación — el detalle (`pinned=... resolved=...`) va solo a `console.error`.

### 2. `/session/start` — CONFIG_INTEGRITY_DRIFT

*(Descripción de la ronda 1 de este fix. La revisión encontró un hueco de fail-open en esta misma verificación — ver la sección "Ronda 2" al final de este addendum para el fix definitivo; el fragmento de código de abajo es el de la ronda 1 y ya NO es el que corre hoy.)*

La comparación vive en `resolveScenarioConfigForNewSession` (`engine-config/resolver.ts`), no en `routes.ts` — es una cuestión de consistencia interna del propio resolver (¿coinciden el registry y el filesystem?), no algo específico de una sesión.

**Cambio de interfaz, deliberadamente pequeño** (opción explícitamente permitida por la revisión: "una lectura adicional coherente"): `ConfigVersionRegistry` gana un segundo método,

```ts
export interface ConfigVersionRegistry {
  resolveActiveVersion(organizationId: string): Promise<string | null>;
  getVersion(organizationId: string, version: string): Promise<{ configHash?: string } | null>;
}
```

implementado por el registry real reusando la función `getVersion` que `repositories/configVersions.ts` YA exponía desde la entrega original de esta fase (no fue necesario escribir lógica de lectura nueva, solo cablear lo que ya existía). Con eso:

```ts
const activeRecord = await registry.getVersion(params.organizationId, activeVersion);
if (activeRecord?.configHash && activeRecord.configHash !== result.hash) {
  return {
    outcome: "no_config_for_organization",
    errors: [`CONFIG_INTEGRITY_DRIFT: ...`],
  };
}
```

- **Fail closed**: ninguna sesión nueva se crea; `routes.ts` responde 503 exactamente como ya respondía para cualquier otro `no_config_for_organization` (sin outcome nuevo — reutilizar el existente mantiene el diseño pequeño, tal como pidió la revisión).
- **Reporte interno vs. externo**: el mensaje `CONFIG_INTEGRITY_DRIFT: ...` (con ambos hashes, para debugging) va a `errors[]`, que `routes.ts` ya logueaba con `console.error` sin exponerlo al cliente — cero cambio necesario en `routes.ts` para que esto quede oculto del cliente; ya era el comportamiento para `no_config_for_organization`.

### 3. `manifest.status` / hash — decisión tomada

**Se excluyó `manifest.status` del hash canónico.** `engine-config/configHash.ts` gana `stripInertManifestFields(pkg)`, que quita `status` del objeto `manifest` antes de canonicalizar — el resto de `manifest` (organizationId, version, las listas de ids) se mantiene en el hash.

**Por qué:** `manifest.status` ya era, desde la entrega original de esta fase, un campo declarado no-autoritativo (ver CONTENT_PACKAGE_STATUS) — la única autoridad sobre draft/active/deprecated es el registry. Un hash pensado para detectar drift de CONTENIDO (`IMMUTABILITY_POLICY`) no debe dispararse por un campo que no cambia nada de lo que una sesión realmente experimenta: pasar `manifest.status` de `"active"` a `"deprecated"` no cambia un solo prompt, criterio, playbook ni content source. Si ese campo participara del hash, alguien podría (razonablemente) esperar que editarlo sea inofensivo — y en cambio dispararía un falso positivo de `IMMUTABILITY_POLICY`/`CONFIG_INTEGRITY_DRIFT` sin que nada real hubiera cambiado.

**Verificado, no solo argumentado:** se flipeó `manifest.status` de `"active"` a `"deprecated"` en el archivo real `backend/config-packages/acme-demo/v1/manifest.json`, se corrió `config:validate` (hash idéntico: `9a1530b4...` en ambos casos), y se restauró el archivo original antes de continuar (`git diff` confirma cero cambios netos en ese archivo).

Consecuencia práctica: **los valores de hash reportados en la entrega original de esta fase (`aad1518c...`, `f7e2d8e8...`) ya no son los que produce el código actual** — no porque el contenido haya cambiado, sino porque `status` dejó de contar. Los valores actuales quedan documentados en TEST_RESULTS (sección original) actualizados abajo.

### 4. Tests nuevos (6, todos verdes)

**`engine-config/resolver.test.ts` (+2, ahora 12):**
- `CONFIG_DRIFT_DETECTION`: el registry recuerda un hash ("AAA") distinto del que el loader calcula ahora mismo para los archivos reales de la versión active → `resolveScenarioConfigForNewSession` devuelve `no_config_for_organization`, nunca `resolved`.
- Caso de control (sin drift): el hash recordado coincide con el hash actual → resuelve normalmente, sin falsos positivos.

**`routes.test.ts` (+4, ahora 219 en el proyecto), nuevo `describe("CONFIG HASH AS A REAL PRECONDITION")`:**
1. Sesión empieza en v1/hash `hash-org-1-v1`; el mock de `/session/end` simula que v1 ahora hashea a `hash-BBB-mutated-in-place` → 503, `evaluatePitchMock` NUNCA llamado (aserción explícita `not.toHaveBeenCalled()`), `failure_reason === "CONFIG_PROVENANCE_HASH_MISMATCH"`, y `config_provenance` de la sesión permanece exactamente igual a como se escribió en `/session/start` (nunca re-pinneado).
2. El mock de `/session/start` simula el outcome que la función real produce ante drift (`no_config_for_organization`) → 503 genérico, sin fuga del detalle interno (`CONFIG_INTEGRITY_DRIFT`) en el body de la respuesta.
3. Caso de control: active v1 sin drift → `/session/start` responde 200 normalmente.
4. Repetición del mismatch con un hash distinto → confirma otra vez que la provenance persistida (`config_provenance`) nunca se sobreescribe con el hash recién resuelto, sea cual sea.

(El caso #4 pedido — "deprecated v1 cuyo hash coincide con la provenance → historical /session/end funciona" — ya estaba cubierto por el test `DEPRECATION_FLOW` existente, fortalecido con un comentario explícito de que su formula de hash por defecto también ejercita el caso sin-drift; y a nivel de función pura por `resolveScenarioConfigForVersion`'s tests de deprecation en `resolver.test.ts`, sin cambios en esta ronda.)

Los 213 tests previos de Fases 1–6 (entrega original) se mantienen verdes sin cambiar sus expectativas.

### Resultados

```
$ npm test
backend:  Test Files  17 passed (17) | Tests  219 passed (219)
frontend: Test Files   2 passed (2)  | Tests    8 passed (8)
```

(219 = 213 de la entrega original de Fase 6 + 6 nuevas: 2 en `engine-config/resolver.test.ts` + 4 en `routes.test.ts`.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores
```

**Hashes reales actualizados** (tras excluir `manifest.status`, corridos de verdad vía `config:validate`, sin Firestore):

```
$ npm run config:validate -- backend/config-packages/acme-demo/v1
configHash: 9a1530b49ebd67f9e7559aff07007fb7367df27bcf583ad783f150192fee5b65
validation: PASS

$ npm run config:validate -- backend/config-packages/acme-demo/v2
configHash: 4a54bf86007e234b72ab01b77e0dc78ea85d6f127aefdf560b6886323a605194
validation: PASS
```

**No deploy. No Firestore real. No Fase 7.**

---

### Ronda 2: fail-closed real en `/session/start` (último fix)

**Veredicto:** `PASS_WITH_FIXES` sobre la ronda 1 de este mismo addendum — arquitectura y hash enforcement aprobados; quedaba un caso pequeño donde la verificación de `/session/start` podía fallar ABIERTA en vez de cerrada. Nada del version registry/storage/CLI/lifecycle se rehizo. No se avanzó a Fase 7.
**Commit del fix (ronda 2):** `16efa0b4154076a6e0bf4c143c698c69f19b3fb7`

**El hueco:** la condición de la ronda 1 era

```ts
if (activeRecord?.configHash && activeRecord.configHash !== result.hash) { /* fail */ }
```

que solo dispara cuando `activeRecord?.configHash` es *truthy*. Si el pointer decía `activeVersion = v1` pero `getVersion(v1)` devolvía `null` (ningún registro) o un registro SIN `configHash`, la condición entera se evaluaba `false` — la sesión arrancaba de todas formas, sin haber podido verificar nada sobre el contenido que supuestamente estaba usando. Ausencia de evidencia se estaba tratando como evidencia de ausencia de drift.

**El fix:** un version record verificable pasa a ser una precondición OBLIGATORIA, no un chequeo opcional. `resolveScenarioConfigForNewSession` ahora exige, en orden, que:

```
activeRecord existe
  Y
activeRecord.configHash existe
  Y
(si activeRecord.status está presente) activeRecord.status === "active"
  Y
activeRecord.configHash === hash actual de los archivos
→ resolved
```

Cualquier ausencia o inconsistencia en cualquiera de esos pasos → el mismo outcome de siempre, `no_config_for_organization`, con un mensaje `CONFIG_INTEGRITY_DRIFT` distinto por causa (registro ausente / sin hash / status inconsistente / hash distinto) que va únicamente a `console.error` — el cliente sigue viendo el 503 genérico de siempre, sin ningún outcome nuevo ni ninguna fuga de detalle.

`ConfigVersionRegistry.getVersion` gana `status` en su tipo de retorno (`{ configHash?: string; status?: ConfigVersionStatus } | null`) — el registry real (`repositories/configVersions.ts`) ya devolvía `status` desde la entrega original de esta fase; solo hacía falta declararlo en la interfaz que `resolver.ts` consume, sin escribir ninguna lectura nueva.

**Tests nuevos (3, `engine-config/resolver.test.ts`, 222 en el proyecto en total):**
1. `activeVersion=v1` + `getVersion(v1) === null` → `no_config_for_organization`.
2. `activeVersion=v1` + registro existente pero sin `configHash` → `no_config_for_organization` (antes: se saltaba la verificación y arrancaba la sesión).
3. Pointer `v1` + registro de `v1` con `status: "deprecated"` (hash coincidente, para aislar que el fallo es por status, no por hash) → `no_config_for_organization`.
4. (caso de control, ya existía, reescrito para usar un registro explícito y completo) registro `active` + hash correcto → `resolved`.

Todos los demás tests de la entrega original de Fase 6 y de su ronda 1 de fixes se mantienen verdes — el `fakeRegistry` de test se ajustó para devolver, por defecto, un registro completo y coincidente (`{ configHash: "fake-hash:<org>:<version>", status: "active" }`) cuando un test no especifica lo contrario, así que ningún test que no le interesa esta verificación necesitó cambios de comportamiento, solo de fixture.

**Resultados:**

```
$ npm test
backend:  Test Files  17 passed (17) | Tests  222 passed (222)
frontend: Test Files   2 passed (2)  | Tests    8 passed (8)
```

(222 = 219 de la ronda 1 de este addendum + 3 nuevas en `engine-config/resolver.test.ts`.)

```
$ npm run build
backend:  tsc -p tsconfig.json  -> sin errores
frontend: tsc -b && vite build  -> sin errores
```

**No deploy. No Firestore real. No Fase 7.**
