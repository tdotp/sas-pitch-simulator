// Firestore-backed Session repository — Phase 4: explicit, durable session
// lifecycle. See PHASE_04_SESSION_LIFECYCLE_REPORT.md for the full state
// machine (SESSION_STATE_MODEL, VALID_TRANSITIONS, CONCURRENCY_MODEL).
//
// All valid state transitions live in this one file — routes.ts never
// writes a `status` field directly, only through these functions.
//
// PERSISTENCE_DISABLED escape hatch (unchanged since Phase 1/3): when
// Firestore persistence is off (local dev without credentials yet), an
// in-memory Map is used instead so the whole app still runs end-to-end.
// That fallback approximates the same semantics (including the
// concurrency guard) but is NOT atomic the way a Firestore transaction
// is — acceptable because it only ever runs single-process, in dev.
import admin from "firebase-admin";
import { isPersistenceEnabled } from "../firebase.js";
import type {
  EvaluationResult,
  SessionRecord,
  SessionStatus,
  SpeechMetrics,
  TranscriptTurn,
} from "../types.js";

const COLLECTION = "sessions";
const MAX_FAILURE_REASON_LENGTH = 300;

const memoryStore = new Map<string, SessionRecord>();

function db() {
  return admin.firestore().collection(COLLECTION);
}

function nowIso(): string {
  return new Date().toISOString();
}

// Never persist more than a short, plain-text reason — no stack traces, no
// request/response bodies beyond what's already truncated by the caller,
// no secrets. Callers (routes.ts) are expected to pass an already-sanitized
// message; this is a second, cheap backstop.
function sanitizeFailureReason(reason: string): string {
  return reason.slice(0, MAX_FAILURE_REASON_LENGTH);
}

// Runtime validation: a session document must have organization_id to be
// usable by this repository's tenant-scoped methods. A document missing
// it is either malformed or — much more likely — a legacy, pre-Phase-3
// session (the ~68 test sessions from before this model existed). Either
// way it's treated as invalid/not found here, never surfaced: see
// LEGACY_SESSION_POLICY in PHASE_04_SESSION_LIFECYCLE_REPORT.md.
const VALID_STATUSES: SessionStatus[] = [
  "in_progress",
  "evaluating",
  "completed",
  "evaluation_failed",
  "persistence_failed",
  "abandoned",
];

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (VALID_STATUSES as string[]).includes(value);
}

function parseSessionRecord(
  id: string,
  data: FirebaseFirestore.DocumentData | undefined
): SessionRecord | null {
  if (!data) return null;
  const { organization_id, user_id, target_mode, status } = data;
  if (
    typeof organization_id !== "string" ||
    !organization_id ||
    typeof user_id !== "string" ||
    typeof target_mode !== "string" ||
    !isSessionStatus(status)
  ) {
    return null;
  }
  return { ...(data as SessionRecord), session_id: id, status };
}

export async function createSession(session: SessionRecord): Promise<void> {
  if (!isPersistenceEnabled()) {
    memoryStore.set(session.session_id, { ...session, updated_at: nowIso() });
    console.log("[sessions:log] created", session.session_id);
    return;
  }
  await db()
    .doc(session.session_id)
    .set({
      ...session,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
}

export async function getSessionById(sessionId: string): Promise<SessionRecord | null> {
  if (!isPersistenceEnabled()) {
    return memoryStore.get(sessionId) ?? null;
  }
  const snap = await db().doc(sessionId).get();
  if (!snap.exists) return null;
  return parseSessionRecord(snap.id, snap.data());
}

// ─────────────────────────────────────────────────────────────
// CONCURRENCY + IDEMPOTENCY: claimSessionForEvaluation
//
// The single entry point into the "someone wants to evaluate this
// session" path. Folds together, in ONE atomic operation:
//   - ownership check (owner_uid)
//   - tenant check (organization_id)
//   - the state transition in_progress|evaluation_failed|
//     persistence_failed -> evaluating
//
// Two concurrent callers racing on the same session_id: Firestore's
// transaction retries the LOSER's callback automatically after the
// winner commits, so the loser re-reads a fresh "evaluating" status and
// returns `in_progress_elsewhere` instead of claiming a second time.
// This is the mechanism that guarantees "solo una evaluación real" —
// not an in-memory lock (which wouldn't hold across instances/restarts).
// ─────────────────────────────────────────────────────────────

export type ClaimOutcome =
  | { outcome: "claimed"; session: SessionRecord }
  | { outcome: "already_completed"; session: SessionRecord }
  | { outcome: "in_progress_elsewhere" }
  // Covers: doesn't exist, wrong owner, wrong org, or an unparseable/
  // legacy doc — all folded into one outcome so the caller can respond
  // with the SAME uniform 404 for every case, exactly as Phase 3 already
  // did for ownership alone. See SECURITY_IMPACT in
  // PHASE_04_SESSION_LIFECYCLE_REPORT.md.
  | { outcome: "not_found" }
  // e.g. `abandoned` — a real, existing, owned session that simply can't
  // be claimed for evaluation anymore.
  | { outcome: "wrong_state"; status: SessionStatus };

const CLAIMABLE_STATUSES: SessionStatus[] = ["in_progress", "evaluation_failed", "persistence_failed"];

function decideClaim(
  session: SessionRecord,
  ownerUid: string,
  organizationId: string
): ClaimOutcome {
  if (session.owner_uid !== ownerUid || session.organization_id !== organizationId) {
    return { outcome: "not_found" };
  }
  if (session.status === "completed") return { outcome: "already_completed", session };
  if (session.status === "evaluating") return { outcome: "in_progress_elsewhere" };
  if (CLAIMABLE_STATUSES.includes(session.status)) {
    return { outcome: "claimed", session: { ...session, status: "evaluating" } };
  }
  return { outcome: "wrong_state", status: session.status };
}

export async function claimSessionForEvaluation(params: {
  sessionId: string;
  ownerUid: string;
  organizationId: string;
}): Promise<ClaimOutcome> {
  if (!isPersistenceEnabled()) {
    const session = memoryStore.get(params.sessionId);
    if (!session) return { outcome: "not_found" };
    const decision = decideClaim(session, params.ownerUid, params.organizationId);
    if (decision.outcome === "claimed") {
      memoryStore.set(params.sessionId, { ...session, status: "evaluating", updated_at: nowIso() });
    }
    return decision;
  }

  const ref = db().doc(params.sessionId);
  return admin.firestore().runTransaction(async (tx): Promise<ClaimOutcome> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: "not_found" };
    const session = parseSessionRecord(snap.id, snap.data());
    if (!session) return { outcome: "not_found" };

    const decision = decideClaim(session, params.ownerUid, params.organizationId);
    if (decision.outcome === "claimed") {
      tx.set(
        ref,
        { status: "evaluating", updated_at: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    return decision;
  });
}

// ─────────────────────────────────────────────────────────────
// GUARDED EXITS FROM "evaluating" (PASS_WITH_FIXES round)
//
// persistCompletedResult / markEvaluationFailed / markPersistenceFailed
// used to write directly, with no precondition — they could overwrite
// ANY status, contradicting VALID_TRANSITIONS. The review caught a real
// case: persistCompletedResult's write actually lands in Firestore
// (status -> completed) but the client of THIS module (routes.ts) gets a
// thrown error anyway (an ambiguous ack — e.g. a network blip after the
// write committed). The old code would then call markPersistenceFailed,
// which would happily downgrade completed -> persistence_failed and
// DISCARD an already-saved result.
//
// Fix: every exit from "evaluating" goes through applyFromEvaluating,
// which only writes if the CURRENT status is exactly "evaluating" —
// enforced via a Firestore transaction (real precondition, not a
// best-effort check) or the equivalent compare-and-set in the memory
// fallback. Any other current status is preserved untouched and reported
// back via `currentStatus`, never silently overwritten.
// ─────────────────────────────────────────────────────────────

export type EvaluatingExitResult =
  | { applied: true }
  // `currentStatus: null` means the session doesn't exist at all (should
  // not happen in the normal flow — these are only ever called right
  // after a successful claim — but handled defensively rather than
  // assumed away).
  | { applied: false; currentStatus: SessionStatus | null };

async function applyFromEvaluating(
  sessionId: string,
  buildUpdate: () => Record<string, unknown>
): Promise<EvaluatingExitResult> {
  if (!isPersistenceEnabled()) {
    const existing = memoryStore.get(sessionId);
    if (!existing) return { applied: false, currentStatus: null };
    if (existing.status !== "evaluating") {
      return { applied: false, currentStatus: existing.status };
    }
    memoryStore.set(sessionId, { ...existing, ...buildUpdate(), updated_at: nowIso() } as SessionRecord);
    return { applied: true };
  }

  const ref = db().doc(sessionId);
  return admin.firestore().runTransaction(async (tx): Promise<EvaluatingExitResult> => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { applied: false, currentStatus: null };
    const session = parseSessionRecord(snap.id, snap.data());
    if (!session) return { applied: false, currentStatus: null };
    if (session.status !== "evaluating") {
      return { applied: false, currentStatus: session.status };
    }
    tx.set(
      ref,
      { ...buildUpdate(), updated_at: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { applied: true };
  });
}

// evaluating -> evaluation_failed ONLY. Any other current status (most
// importantly `completed`) is preserved untouched.
export async function markEvaluationFailed(
  sessionId: string,
  reason: string
): Promise<EvaluatingExitResult> {
  // `reason` is expected to already be a short, safe category (e.g.
  // "OPENROUTER_TIMEOUT") — see FAILURE_REASON_TAXONOMY in
  // PHASE_04_SESSION_LIFECYCLE_REPORT.md. Truncation here is a second,
  // cheap backstop, not the primary sanitization.
  const failure_reason = sanitizeFailureReason(reason);
  const result = await applyFromEvaluating(sessionId, () => ({
    status: "evaluation_failed",
    failure_reason,
  }));
  if (result.applied) {
    console.log("[sessions:log] evaluation_failed", sessionId, failure_reason);
  } else {
    console.warn(
      `[sessions] markEvaluationFailed(${sessionId}) rechazado: status actual es ` +
        `"${result.currentStatus ?? "desconocido"}", no "evaluating" — no se sobrescribió nada.`
    );
  }
  return result;
}

// evaluating -> persistence_failed ONLY. Deliberately its own small write
// (status + reason only, no transcript/metrics/evaluation payload) — if
// the FULL result write in persistCompletedResult failed, a smaller write
// has a better chance of succeeding, and there's no result to attach
// anyway in the genuine-failure case. But see the guard above: if the
// original write actually DID land (status is already `completed`), this
// call is REJECTED and completed is preserved — the whole point of this
// round's fix.
export async function markPersistenceFailed(
  sessionId: string,
  reason: string
): Promise<EvaluatingExitResult> {
  const failure_reason = sanitizeFailureReason(reason);
  const result = await applyFromEvaluating(sessionId, () => ({
    status: "persistence_failed",
    failure_reason,
  }));
  if (result.applied) {
    console.log("[sessions:log] persistence_failed", sessionId, failure_reason);
  } else {
    console.warn(
      `[sessions] markPersistenceFailed(${sessionId}) rechazado: status actual es ` +
        `"${result.currentStatus ?? "desconocido"}", no "evaluating" — no se sobrescribió nada ` +
        `(si es "completed", el resultado original se conserva intacto).`
    );
  }
  return result;
}

// evaluating -> completed ONLY. The one write that makes a session
// durably "done" — transcript + metrics + evaluation land together with
// the status flip, in a single Firestore transactional write, so a
// reader can never see status:"completed" without the result already
// there. If this throws, the caller (routes.ts) MUST call
// markPersistenceFailed and MUST NOT report success to the client — see
// PERSISTENCE_FAILURE_MODEL. If it returns `applied: false`, the current
// status (whatever it is) was preserved untouched.
export async function persistCompletedResult(
  sessionId: string,
  params: {
    duration_seconds: number;
    transcript: TranscriptTurn[];
    metrics: SpeechMetrics;
    evaluation: EvaluationResult;
  }
): Promise<EvaluatingExitResult> {
  // Phase 5 fix (PASS_WITH_FIXES): no hardcoded person name — VOCERO
  // (spokesperson) / ENTREVISTADOR are neutral role labels, same pair used
  // by engine/evaluatorPromptBuilder.ts's transcriptToText().
  const full = params.transcript
    .map((t) => `${t.role === "user" ? "VOCERO" : "ENTREVISTADOR"}: ${t.text}`)
    .join("\n");
  const userOnly = params.transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join("\n");
  const agentOnly = params.transcript
    .filter((t) => t.role === "agent")
    .map((t) => t.text)
    .join("\n");
  const transcript = { full, user_only: userOnly, agent_only: agentOnly };

  const result = await applyFromEvaluating(sessionId, () => ({
    status: "completed",
    ended_at: nowIso(),
    duration_seconds: params.duration_seconds,
    transcript,
    metrics: params.metrics,
    evaluation: params.evaluation,
  }));
  if (result.applied) {
    console.log("[sessions:log] completed", sessionId, { overall: params.evaluation.overall_score });
  } else {
    console.warn(
      `[sessions] persistCompletedResult(${sessionId}) rechazado: status actual es ` +
        `"${result.currentStatus ?? "desconocido"}", no "evaluating" — no se sobrescribió nada.`
    );
  }
  return result;
}

// in_progress -> abandoned. NOT wired to any HTTP route or scheduler in
// this phase (see ABANDONED_POLICY) — called from
// backend/scripts/mark-abandoned-sessions.ts, a manual/cron-able helper.
// Transaction-guarded for the same reason claimSessionForEvaluation is:
// avoids racing a real, in-flight /session/end call that claims the
// session (in_progress -> evaluating) at the same moment a sweep tries to
// mark it abandoned.
export async function markAbandoned(sessionId: string): Promise<
  { outcome: "abandoned" } | { outcome: "not_found" } | { outcome: "not_abandonable"; status: SessionStatus }
> {
  if (!isPersistenceEnabled()) {
    const existing = memoryStore.get(sessionId);
    if (!existing) return { outcome: "not_found" };
    if (existing.status !== "in_progress") {
      return { outcome: "not_abandonable", status: existing.status };
    }
    memoryStore.set(sessionId, { ...existing, status: "abandoned", updated_at: nowIso() });
    return { outcome: "abandoned" };
  }

  const ref = db().doc(sessionId);
  return admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { outcome: "not_found" as const };
    const session = parseSessionRecord(snap.id, snap.data());
    if (!session) return { outcome: "not_found" as const };
    if (session.status !== "in_progress") {
      return { outcome: "not_abandonable" as const, status: session.status };
    }
    tx.set(ref, { status: "abandoned", updated_at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { outcome: "abandoned" as const };
  });
}

// Tenant-scoped read for GET /admin/sessions AND for the abandonment
// sweep helper (filtering by status client-side there — see
// mark-abandoned-sessions.ts).
//
// Deliberately does NOT add `.orderBy("created_at")` on top of the
// equality filter: a Firestore query combining an equality filter with an
// orderBy on a DIFFERENT field requires a composite index (equality alone
// does not). This fetches every session for the organization (one
// equality filter, auto-indexed) and sorts by `started_at` + slices to
// `limit` in memory instead — proportional for current volume. See
// FIRESTORE_MODEL in PHASE_04_SESSION_LIFECYCLE_REPORT.md.
export async function listSessionsByOrganization(
  organizationId: string,
  limit = 50
): Promise<SessionRecord[]> {
  if (!isPersistenceEnabled()) {
    return sortByStartedAtDesc(
      [...memoryStore.values()].filter((s) => s.organization_id === organizationId)
    ).slice(0, limit);
  }
  const snap = await db().where("organization_id", "==", organizationId).get();
  const sessions = snap.docs
    .map((d) => parseSessionRecord(d.id, d.data()))
    .filter((s): s is SessionRecord => s !== null);
  return sortByStartedAtDesc(sessions).slice(0, limit);
}

function sortByStartedAtDesc(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
}

// Not wired to any route yet (V1 role policy for /admin/sessions is
// org-scoped, not per-user — see PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md).
// Kept for the same reason it was added in Phase 3: a future per-user view
// will need exactly this shape. Same index reasoning as above — two bare
// equality filters need no composite index, but adding orderBy would, so
// this sorts in memory too.
export async function listSessionsByOrganizationAndUser(
  organizationId: string,
  userId: string,
  limit = 50
): Promise<SessionRecord[]> {
  if (!isPersistenceEnabled()) {
    return sortByStartedAtDesc(
      [...memoryStore.values()].filter(
        (s) => s.organization_id === organizationId && s.user_id === userId
      )
    ).slice(0, limit);
  }
  const snap = await db()
    .where("organization_id", "==", organizationId)
    .where("user_id", "==", userId)
    .get();
  const sessions = snap.docs
    .map((d) => parseSessionRecord(d.id, d.data()))
    .filter((s): s is SessionRecord => s !== null);
  return sortByStartedAtDesc(sessions).slice(0, limit);
}

// Used only by backend/scripts/mark-abandoned-sessions.ts. A single
// equality filter (`status == "in_progress"`) — auto-indexed, no
// composite index needed. Intentionally NOT organization-scoped: the
// sweep is a cross-tenant maintenance operation (an operator running a
// script), not a user-facing read — see ABANDONED_POLICY.
export async function listInProgressSessionsOlderThan(cutoffIso: string): Promise<SessionRecord[]> {
  if (!isPersistenceEnabled()) {
    return [...memoryStore.values()].filter(
      (s) => s.status === "in_progress" && (s.started_at ?? "") < cutoffIso
    );
  }
  const snap = await db().where("status", "==", "in_progress").get();
  return snap.docs
    .map((d) => parseSessionRecord(d.id, d.data()))
    .filter((s): s is SessionRecord => s !== null && (s.started_at ?? "") < cutoffIso);
}
