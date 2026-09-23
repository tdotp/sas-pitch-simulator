// Fase 7 — STALE_EVALUATING_POLICY. Manual recovery sweep for sessions
// stuck in "evaluating": a provider call fails AND the failure-state write
// itself also fails (see the `.catch` sites in routes.ts around
// markEvaluationFailed/markPersistenceFailed) — the session never reaches
// evaluation_failed/persistence_failed and stays claimed forever. NOT wired
// to any scheduler/cron, same deliberate choice as
// mark-abandoned-sessions.ts (Phase 4) for this phase — run by hand (or
// from an external scheduler later):
//
//   npx tsx backend/scripts/mark-stale-evaluating-sessions.ts [--hours=2] [--dry-run]
//
// Rule: any session still `evaluating` whose updated_at (stamped by
// claimSessionForEvaluation's transaction at the exact moment it entered
// "evaluating" — see repositories/sessions.ts) is older than the cutoff
// (default 2 hours — a real evaluation completes in well under a minute:
// OpenRouter's own worst case is one 30s attempt + one 30s retry, and
// ElevenLabs's signed-url call has a 10s timeout; 2 hours comfortably
// clears that worst case with room to spare) becomes a candidate. Each
// candidate is transitioned through markEvaluationFailed(sessionId,
// "STALE_EVALUATION_TIMEOUT") — the SAME transaction-guarded,
// evaluating-only-guarded function /session/end itself uses (see
// applyFromEvaluating in repositories/sessions.ts), so a real /session/end
// call racing this sweep is handled exactly the way
// mark-abandoned-sessions.ts already handles a race with markAbandoned:
// the guard rejects the write if the status changed, and the sweep skips
// it instead of overwriting a legitimate in-flight or since-completed
// evaluation. Idempotent and safe to re-run.

import { initFirebase, isAuthReady } from "../src/firebase.js";
import { listEvaluatingSessionsOlderThan, markEvaluationFailed } from "../src/repositories/sessions.js";
import { parseHours } from "./staleEvaluatingArgs.js";

// PASS_WITH_FIXES P1.2: --hours is validated BEFORE anything else in
// main() touches Firebase — an invalid value (negative, zero, NaN,
// Infinity) exits here, with no Firestore query and no write. See
// staleEvaluatingArgs.ts for the validation rule and why it matters.
function parseArgs(): { hours: number; dryRun: boolean } | null {
  const args = process.argv.slice(2);
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const rawHours = hoursArg ? hoursArg.split("=")[1] : undefined;
  const parsedHours = parseHours(rawHours);
  if (!parsedHours.ok) {
    console.error(`[stale-evaluating-sweep] ${parsedHours.error}`);
    console.error(
      "[stale-evaluating-sweep] Uso: mark-stale-evaluating-sessions.ts [--hours=N] [--dry-run]  (N debe ser > 0)"
    );
    return null;
  }
  const dryRun = args.includes("--dry-run");
  return { hours: parsedHours.hours, dryRun };
}

async function main() {
  const parsedArgs = parseArgs();
  if (!parsedArgs) {
    process.exit(1);
    return;
  }
  const { hours, dryRun } = parsedArgs;

  initFirebase();
  if (!isAuthReady()) {
    console.error(
      "[stale-evaluating-sweep] Firebase Admin no se pudo inicializar. Abortando sin escribir nada."
    );
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  console.log(
    `[stale-evaluating-sweep] Buscando sesiones evaluating con updated_at antes de ${cutoff} ` +
      `(> ${hours}h)${dryRun ? " — DRY RUN, no se escribe nada" : ""}.`
  );

  const candidates = await listEvaluatingSessionsOlderThan(cutoff);
  console.log(`[stale-evaluating-sweep] ${candidates.length} candidata(s) encontrada(s).`);

  for (const session of candidates) {
    if (dryRun) {
      console.log(
        `[stale-evaluating-sweep] (dry-run) marcaría evaluation_failed: ${session.session_id} ` +
          `(updated_at=${session.updated_at})`
      );
      continue;
    }
    const result = await markEvaluationFailed(session.session_id, "STALE_EVALUATION_TIMEOUT");
    if (result.applied) {
      console.log(`[stale-evaluating-sweep] evaluation_failed: ${session.session_id}`);
    } else {
      // Raced with a real /session/end (or an earlier run of this same
      // sweep) between listing and writing — expected occasionally, not an
      // error. If currentStatus is "completed", the original evaluation
      // won — exactly the outcome we want, nothing lost.
      console.log(
        `[stale-evaluating-sweep] omitida (ya no es evaluating, status=${result.currentStatus ?? "desconocido"}): ${session.session_id}`
      );
    }
  }

  console.log("[stale-evaluating-sweep] Listo.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[stale-evaluating-sweep] Error:", err);
  process.exit(1);
});
