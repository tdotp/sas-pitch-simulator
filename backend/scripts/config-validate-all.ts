// Fase 9 (Quality Gate) — config package validation gate step: validates
// EVERY <organizationId>/<version> package actually committed under
// backend/config-packages/, not just one path at a time like
// config:validate. Same two-pass validation (structural + semantic) via
// the same FileConfigPackageLoader used in production. Pure read-only —
// no initFirebase(), no network, no writes. Safe for CI / offline runs.
//
//   npm run config:validate-all

import { FileConfigPackageLoader } from "../src/engine-config/loader.js";
import { discoverConfigPackageVersions, validateAllConfigPackages } from "../src/engine-config/validateAllPackages.js";

async function main() {
  const loader = new FileConfigPackageLoader();
  const versions = await discoverConfigPackageVersions();

  if (versions.length === 0) {
    console.error("[config:validate-all] No se encontró ningún paquete bajo config-packages/.");
    process.exit(1);
  }

  const results = await validateAllConfigPackages(versions, loader);
  let failures = 0;

  for (const r of results) {
    if (r.valid) {
      console.log(`[PASS] ${r.organizationId}/${r.version}`);
    } else {
      failures += 1;
      console.error(`[FAIL] ${r.organizationId}/${r.version}`);
      for (const err of r.errors) console.error(`   - ${err}`);
    }
  }

  console.log(`\n${results.length - failures}/${results.length} paquetes válidos.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[config:validate-all] Error inesperado:", err);
  process.exit(1);
});
