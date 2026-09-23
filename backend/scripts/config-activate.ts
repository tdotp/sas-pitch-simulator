// ACTIVATION_FLOW (Phase 6): the explicit `activateConfigVersion(org,
// version)` operation as a standalone CLI step, for a version already
// registered (via config:import) and QA'd. Re-validates the package
// itself before touching any status (NO ACTIVAR CONFIG INVÁLIDA), and
// refuses on an IMMUTABILITY_POLICY violation. Deprecates whichever
// version was previously active for this organization (UNA SOLA ACTIVE
// VERSION) — without deleting it.
//
//   npm run config:activate -- <organizationId> <version>
//
// The package files are still located the normal way, under
// backend/config-packages/<organizationId>/<version>/ (DEFAULT_ROOT) —
// this script does not accept an arbitrary path the way config:validate/
// config:import do, since activating something that was never imported
// from its normal published location would defeat STORAGE_DECISION's
// git-as-source-of-truth model.

import { activateConfigVersion } from "../src/repositories/configVersions.js";
import { initFirebase, isAuthReady } from "../src/firebase.js";

function usageAndExit(): never {
  console.error("Uso: npm run config:activate -- <organizationId> <version>");
  process.exit(1);
}

async function main() {
  const [organizationId, version] = process.argv.slice(2);
  if (!organizationId || !version) usageAndExit();

  initFirebase();
  if (!isAuthReady()) {
    console.error("[config:activate] Firebase Admin no se pudo inicializar. Abortando sin escribir nada.");
    process.exit(1);
  }

  const result = await activateConfigVersion(organizationId, version);

  if (result.outcome === "activated") {
    console.log(
      `activada: ${organizationId}/${version}` +
        (result.previousActiveVersion
          ? ` (versión previa "${result.previousActiveVersion}" pasó a deprecated, no eliminada)`
          : " (primera versión active para esta organización)")
    );
    process.exit(0);
  }
  if (result.outcome === "invalid_package") {
    console.error(`[config:activate] rechazada — el paquete ${organizationId}/${version} no es válido:`);
    result.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.error(
    `[config:activate] rechazada — IMMUTABILITY_POLICY: el hash registrado (${result.recordedHash}) ` +
      `no coincide con el hash actual del contenido en disco (${result.currentHash}) para ` +
      `${organizationId}/${result.version}. El contenido de una versión ya usada no puede editarse en sitio.`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[config:activate] Error inesperado:", err);
  process.exit(1);
});
