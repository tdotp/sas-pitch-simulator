// VALIDATION_TOOLING (Phase 6): reproducible, scriptable validation of a
// config package BEFORE it's ever imported/activated. Pure read-only —
// touches no Firestore, no repo state. Same two-pass validation the real
// request path runs (structural Zod + semantic cross-references), via
// the exact same FileConfigPackageLoader used in production.
//
//   npm run config:validate -- <path-to-version-dir>
//
// <path> is a directory containing manifest.json/client.json/scenarios/
// etc. directly — e.g. backend/config-packages/acme-demo/v2, or a
// freshly-transformed draft package living anywhere else on disk (a temp
// extraction of VOCERIA_CLIENT_CONTENT_TEMPLATE.zip, for instance). The
// organizationId and version are read from the path itself
// (<root>/<organizationId>/<version>), matching manifest.json's own
// organizationId/version fields — which the loader cross-checks.

import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FileConfigPackageLoader } from "../src/engine-config/loader.js";

function usageAndExit(): never {
  console.error("Uso: npm run config:validate -- <path-a-la-carpeta-de-version>");
  console.error("Ejemplo: npm run config:validate -- backend/config-packages/acme-demo/v1");
  process.exit(1);
}

async function main() {
  const target = process.argv[2];
  if (!target) usageAndExit();

  const absTarget = resolve(target);
  const version = basename(absTarget);
  const organizationId = basename(dirname(absTarget));
  const root = pathToFileURL(dirname(dirname(absTarget)) + "/");

  const loader = new FileConfigPackageLoader(root);
  const result = await loader.loadPackage(organizationId, version);

  if (!result.valid) {
    console.error(`\nvalidation: FAIL\norganization: ${organizationId}\nversion: ${version}\n`);
    for (const err of result.errors) console.error(`  - ${err}`);
    console.error(`\n${result.errors.length} error(es).`);
    process.exit(1);
  }

  const { pkg, hash } = result;
  console.log("");
  console.log(`organization: ${pkg.manifest.organizationId}`);
  console.log(`version: ${pkg.manifest.version}`);
  console.log(`scenarios: ${pkg.scenarios.length}`);
  console.log(`interviewers: ${pkg.interviewerProfiles.length}`);
  console.log(`frameworks: ${pkg.evaluationFrameworks.length}`);
  console.log(`contentSources: ${pkg.contentSources.length}`);
  console.log(`configHash: ${hash}`);
  console.log(`validation: PASS`);
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("[config:validate] Error inesperado:", err);
  process.exit(1);
});
