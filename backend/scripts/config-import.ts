// CONTENT_INTEGRATION_CONTRACT (Phase 6): the "publish draft" (and,
// optionally in one step, "activate") half of:
//
//   FUENTES DEL CLIENTE -> VOCERIA_CLIENT_CONTENT_TEMPLATE -> validación
//   humana -> transformación a config-package -> schema validation ->
//   semantic validation -> publish draft -> QA -> activate -> new
//   sessions use that version
//
//   npm run config:import -- <path-to-version-dir> [--dry-run] [--activate]
//
// Same validation as config-validate.ts (never skipped, never
// weakened). --dry-run: prints the summary and writes NOTHING — no
// registry entry, draft or otherwise (see DRY_RUN_FLOW). Without
// --dry-run: registers a `draft` entry in the version registry if one
// doesn't already exist (idempotent — never downgrades an
// active/deprecated entry). --activate (implies a real write even
// without it): additionally calls activateConfigVersion, which
// re-validates the package itself before touching any status (NO
// ACTIVAR CONFIG INVÁLIDA) and refuses on an IMMUTABILITY_POLICY
// violation (content changed since this version was first activated).

import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileConfigPackageLoader } from "../src/engine-config/loader.js";
import { registerDraftVersion, activateConfigVersion } from "../src/repositories/configVersions.js";
import { initFirebase, isAuthReady } from "../src/firebase.js";

function usageAndExit(): never {
  console.error("Uso: npm run config:import -- <path-a-la-carpeta-de-version> [--dry-run] [--activate]");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const activate = args.includes("--activate");
  if (!target) usageAndExit();

  const absTarget = resolve(target);
  const version = basename(absTarget);
  const organizationId = basename(dirname(absTarget));
  const root = pathToFileURL(dirname(dirname(absTarget)) + "/");

  const loader = new FileConfigPackageLoader(root);
  const result = await loader.loadPackage(organizationId, version);

  console.log("");
  console.log(`organization: ${organizationId}`);
  console.log(`version: ${version}`);

  if (!result.valid) {
    console.log("validation: FAIL");
    for (const err of result.errors) console.error(`  - ${err}`);
    console.log("");
    console.error(`${result.errors.length} error(es) — no se escribió nada.`);
    process.exit(1);
  }

  console.log(`scenarios: ${result.pkg.scenarios.length}`);
  console.log(`interviewers: ${result.pkg.interviewerProfiles.length}`);
  console.log(`frameworks: ${result.pkg.evaluationFrameworks.length}`);
  console.log(`contentSources: ${result.pkg.contentSources.length}`);
  console.log(`configHash: ${result.hash}`);
  console.log("validation: PASS");

  if (dryRun) {
    console.log("\n(dry-run) no se escribió ningún estado.\n");
    process.exit(0);
  }

  // Only from here on does anything get written — needs Firebase Admin
  // for the version registry (Firestore), same bootstrap every other
  // scripts/*.ts uses.
  initFirebase();
  if (!isAuthReady()) {
    console.error(
      "[config:import] Firebase Admin no se pudo inicializar. Abortando sin escribir nada " +
        "(o corre con --dry-run si solo quieres validar)."
    );
    process.exit(1);
  }

  const { created, record } = await registerDraftVersion(organizationId, version);
  console.log(
    created
      ? `\nregistrada como draft: ${organizationId}/${version}`
      : `\nya existía en el registro (status actual: ${record.status}) — sin cambios.`
  );

  if (activate) {
    const activation = await activateConfigVersion(organizationId, version, loader);
    if (activation.outcome === "activated") {
      console.log(
        `activada: ${organizationId}/${version}` +
          (activation.previousActiveVersion
            ? ` (versión previa "${activation.previousActiveVersion}" pasó a deprecated)`
            : " (primera versión active para esta organización)")
      );
    } else if (activation.outcome === "invalid_package") {
      console.error("[config:import] activación rechazada — el paquete no es válido:");
      activation.errors.forEach((e) => console.error(`  - ${e}`));
      process.exit(1);
    } else {
      console.error(
        `[config:import] activación rechazada — IMMUTABILITY_POLICY: el hash registrado para ` +
          `${organizationId}/${version} (${activation.recordedHash}) no coincide con el hash actual ` +
          `(${activation.currentHash}). El contenido de una versión ya usada no puede editarse en sitio — ` +
          `publica un ${version === "v1" ? "v2" : "siguiente número de versión"} nuevo en su lugar.`
      );
      process.exit(1);
    }
  }

  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("[config:import] Error inesperado:", err);
  process.exit(1);
});
