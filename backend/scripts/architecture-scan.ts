// Fase 9 (Quality Gate) — ENGINE_GENERICITY static check, CLI entry.
// Pure read-only, no Firestore/network. Fails (non-zero exit) if any
// architecture violation is found in generic engine source.
//
//   npm run architecture:scan

import { fileURLToPath } from "node:url";
import { runGenericEngineScan } from "../src/architecture/runGenericEngineScan.js";

async function main() {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const backendRoot = fileURLToPath(new URL("../", import.meta.url));

  const violations = await runGenericEngineScan(srcRoot, backendRoot);

  if (violations.length === 0) {
    console.log("[PASS] architecture:scan — 0 violaciones de ENGINE_GENERICITY.");
    process.exit(0);
  }

  console.error(`[FAIL] architecture:scan — ${violations.length} violación(es):\n`);
  for (const v of violations) {
    console.error(`  ${v.rule}  ${v.file}:${v.line}\n    ${v.snippet}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("[architecture:scan] Error inesperado:", err);
  process.exit(1);
});
