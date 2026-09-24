// Fase 9 (Quality Gate) — CLI entry. The ONLY file that spawns real
// subprocesses. Deterministic order (documented per spec item 11):
// backend tests -> backend build -> backend scripts typecheck ->
// frontend tests -> frontend build -> config package validation (all) ->
// generic engine architecture scan. AGGREGATE mode — every step always
// runs (see qualityGate.ts).
//
// TEST_ENVIRONMENT_SAFETY (Fase 9 spec item 13): this is the exhaustive,
// explicit list of every command this gate runs. It NEVER runs
// config:activate, config:import, sessions:mark-abandoned, or
// sessions:mark-stale-evaluating — those are live, Firestore-writing
// operator scripts, not gate steps. Adding a new step means adding it
// here AND to PHASE_09_TESTS_QUALITY_GATE_REPORT.md's
// TEST_ENVIRONMENT_SAFETY section, never silently.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runQualityGateSteps, formatReport, computeExitCode, type QualityGateStep } from "./qualityGate.js";

const BACKEND_DIR = fileURLToPath(new URL("../", import.meta.url));
const FRONTEND_DIR = fileURLToPath(new URL("../../frontend/", import.meta.url));

function npmRunStep(name: string, script: string, cwd: string): QualityGateStep {
  return {
    name,
    run: async () => {
      const result = spawnSync("npm", ["run", script], { cwd, stdio: "inherit" });
      return { ok: result.status === 0 };
    },
  };
}

function npmTestStep(name: string, cwd: string): QualityGateStep {
  return {
    name,
    run: async () => {
      const result = spawnSync("npm", ["test"], { cwd, stdio: "inherit" });
      return { ok: result.status === 0 };
    },
  };
}

const STEPS: QualityGateStep[] = [
  npmTestStep("backend tests", BACKEND_DIR),
  npmRunStep("backend build", "build", BACKEND_DIR),
  npmRunStep("backend scripts typecheck", "typecheck:scripts", BACKEND_DIR),
  npmTestStep("frontend tests", FRONTEND_DIR),
  npmRunStep("frontend build", "build", FRONTEND_DIR),
  npmRunStep("config package validation (all)", "config:validate-all", BACKEND_DIR),
  npmRunStep("generic engine architecture scan", "architecture:scan", BACKEND_DIR),
];

async function main() {
  const run = await runQualityGateSteps(STEPS);
  console.log("\n" + formatReport(run) + "\n");
  process.exit(computeExitCode(run));
}

main();
