// PASS_WITH_FIXES P1.2: pure --hours validation for
// mark-stale-evaluating-sessions.ts, deliberately in its own module with
// no Firebase import — see the comment in staleEvaluatingArgs.test.ts for
// why. Rule: finite and > 0. A negative value would produce a cutoff
// timestamp in the FUTURE (Date.now() - hours*3600000), which would match
// legitimate, still-running `evaluating` sessions as "stale". Zero,
// NaN and Infinity are equally nonsensical as an hours threshold.
export type ParsedHours = { ok: true; hours: number } | { ok: false; error: string };

const DEFAULT_HOURS = 2;

export function parseHours(raw: string | undefined): ParsedHours {
  if (raw === undefined) {
    return { ok: true, hours: DEFAULT_HOURS };
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    return {
      ok: false,
      error: `--hours debe ser un número finito mayor que 0 (recibido: "${raw}")`,
    };
  }
  return { ok: true, hours };
}
