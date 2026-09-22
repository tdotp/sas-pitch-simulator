// Manual abandonment sweep (Phase 4). NOT wired to any scheduler/cron —
// see ABANDONED_POLICY in PHASE_04_SESSION_LIFECYCLE_REPORT.md for why
// that's deliberate for this phase. Run by hand (or from an external
// scheduler later, e.g. a VPS cron calling this script) whenever you want
// to sweep stale sessions:
//
//   npx tsx backend/scripts/mark-abandoned-sessions.ts [--hours=6] [--dry-run]
//
// Rule: any session still `in_progress` whose started_at is older than
// the cutoff (default 6 hours — a real practice session is minutes long,
// so anything still "in_progress" for hours means the browser tab closed,
// crashed, or the network died before /session/end ever ran) becomes a
// candidate. Each candidate is marked `abandoned` through the SAME
// transaction-guarded repository function /session/end's claim path
// would use to prevent a race — if a real /session/end call claims the
// session between listing it and this script writing to it, the
// transaction detects that (status is no longer in_progress) and the
// script skips it instead of overwriting a legitimate in-flight
// evaluation. Idempotent and safe to re-run.

import { initFirebase, isAuthReady } from "../src/firebase.js";
import { listInProgressSessionsOlderThan, markAbandoned } from "../src/repositories/sessions.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const hours = hoursArg ? Number(hoursArg.split("=")[1]) : 6;
  const dryRun = args.includes("--dry-run");
  return { hours, dryRun };
}

async function main() {
  const { hours, dryRun } = parseArgs();

  initFirebase();
  if (!isAuthReady()) {
    console.error(
      "[abandon-sweep] Firebase Admin no se pudo inicializar. Abortando sin escribir nada."
    );
    process.exit(1);
  }

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  console.log(
    `[abandon-sweep] Buscando sesiones in_progress iniciadas antes de ${cutoff} ` +
      `(> ${hours}h)${dryRun ? " — DRY RUN, no se escribe nada" : ""}.`
  );

  const candidates = await listInProgressSessionsOlderThan(cutoff);
  console.log(`[abandon-sweep] ${candidates.length} candidata(s) encontrada(s).`);

  for (const session of candidates) {
    if (dryRun) {
      console.log(`[abandon-sweep] (dry-run) marcaría abandoned: ${session.session_id} (started_at=${session.started_at})`);
      continue;
    }
    const result = await markAbandoned(session.session_id);
    if (result.outcome === "abandoned") {
      console.log(`[abandon-sweep] abandoned: ${session.session_id}`);
    } else if (result.outcome === "not_abandonable") {
      // Raced with a real /session/end claim between listing and writing
      // — expected occasionally, not an error.
      console.log(
        `[abandon-sweep] omitida (ya no es in_progress, status=${result.status}): ${session.session_id}`
      );
    } else {
      console.log(`[abandon-sweep] omitida (ya no existe): ${session.session_id}`);
    }
  }

  console.log("[abandon-sweep] Listo.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[abandon-sweep] Error:", err);
  process.exit(1);
});
