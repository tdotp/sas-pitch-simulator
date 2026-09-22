// Firestore-backed Session repository (Phase 3).
//
// Replaces the Phase 1 in-memory `sessions` Map in routes.ts AND the
// generic saveSessionStart/saveSessionResult/listSessions helpers that
// used to live in firebase.ts. This is explicit, tenant-aware access —
// not a full session lifecycle (Phase 4 is still what owns state machine
// concerns like abandonment, multi-instance coordination beyond what's
// needed here, and historical migration).
//
// PERSISTENCE_DISABLED escape hatch (unchanged behavior from before
// Phase 3): when Firestore persistence is off (local dev without
// credentials yet), an in-memory Map is used instead so the whole app
// still runs end-to-end. This module-local Map is NOT the durable store —
// it exists purely for that dev convenience. Whenever persistence is
// enabled (the normal/production case), everything goes through
// Firestore, which is what makes the /session/end ownership check durable
// across restarts and multiple backend instances.
import admin from "firebase-admin";
import { isPersistenceEnabled } from "../firebase.js";
import type {
  EvaluationResult,
  SessionRecord,
  SpeechMetrics,
  TranscriptTurn,
} from "../types.js";

const COLLECTION = "sessions";

const memoryStore = new Map<string, SessionRecord>();

// Runtime validation: a session document must have organization_id to be
// usable by this repository's tenant-scoped methods. A document missing
// it is either malformed or — much more likely — a legacy, pre-Phase-3
// session (the ~68 test sessions from before this model existed). Either
// way it's treated as invalid/not found here, never surfaced: see
// LEGACY_SESSION_POLICY in PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md for
// why that's the safe default.
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
    typeof status !== "string"
  ) {
    return null;
  }
  return { ...(data as SessionRecord), session_id: id };
}

export async function createSession(session: SessionRecord): Promise<void> {
  if (!isPersistenceEnabled()) {
    memoryStore.set(session.session_id, session);
    console.log("[sessions:log] created", session.session_id);
    return;
  }
  await admin
    .firestore()
    .collection(COLLECTION)
    .doc(session.session_id)
    .set({ ...session, created_at: admin.firestore.FieldValue.serverTimestamp() });
}

export async function getSessionById(sessionId: string): Promise<SessionRecord | null> {
  if (!isPersistenceEnabled()) {
    return memoryStore.get(sessionId) ?? null;
  }
  const snap = await admin.firestore().collection(COLLECTION).doc(sessionId).get();
  if (!snap.exists) return null;
  return parseSessionRecord(snap.id, snap.data());
}

export async function completeSession(
  sessionId: string,
  params: {
    duration_seconds: number;
    transcript: TranscriptTurn[];
    metrics: SpeechMetrics;
    evaluation: EvaluationResult;
  }
): Promise<void> {
  if (!isPersistenceEnabled()) {
    const existing = memoryStore.get(sessionId);
    if (existing) {
      existing.status = "completed";
      existing.ended_at = new Date().toISOString();
      existing.duration_seconds = params.duration_seconds;
    }
    console.log("[sessions:log] completed", sessionId, {
      overall: params.evaluation.overall_score,
    });
    return;
  }

  const full = params.transcript
    .map((t) => `${t.role === "user" ? "SANDRA" : "AGENTE"}: ${t.text}`)
    .join("\n");
  const userOnly = params.transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join("\n");
  const agentOnly = params.transcript
    .filter((t) => t.role === "agent")
    .map((t) => t.text)
    .join("\n");

  await admin
    .firestore()
    .collection(COLLECTION)
    .doc(sessionId)
    .set(
      {
        status: "completed",
        ended_at: new Date().toISOString(),
        duration_seconds: params.duration_seconds,
        transcript: { full, user_only: userOnly, agent_only: agentOnly },
        metrics: params.metrics,
        evaluation: params.evaluation,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

// Tenant-scoped read for GET /admin/sessions.
//
// Deliberately does NOT add `.orderBy("created_at")` on top of the
// equality filter: a Firestore query combining an equality filter with an
// orderBy on a DIFFERENT field requires a composite index (equality alone
// does not). To avoid depending on a composite index that would need to be
// created/deployed as an infra change — out of scope for a "no deploy"
// phase — this fetches every session for the organization (one equality
// filter, auto-indexed by Firestore, no composite index needed) and sorts
// by `started_at` + slices to `limit` in memory instead. This is NOT
// "traer todo y filtrar en JS" globally — the Firestore query is already
// scoped to exactly one organization; only the final sort/limit happens
// client-side. Proportional for current volume (68 sessions total across
// ALL organizations as of this phase). See FIRESTORE_QUERIES_AND_INDEXES
// in PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md for the exact composite
// index to add instead if/when an organization's session volume grows
// large enough that this stops being proportional.
export async function listSessionsByOrganization(
  organizationId: string,
  limit = 50
): Promise<SessionRecord[]> {
  if (!isPersistenceEnabled()) {
    return sortByStartedAtDesc(
      [...memoryStore.values()].filter((s) => s.organization_id === organizationId)
    ).slice(0, limit);
  }
  const snap = await admin
    .firestore()
    .collection(COLLECTION)
    .where("organization_id", "==", organizationId)
    .get();
  const sessions = snap.docs
    .map((d) => parseSessionRecord(d.id, d.data()))
    .filter((s): s is SessionRecord => s !== null);
  return sortByStartedAtDesc(sessions).slice(0, limit);
}

function sortByStartedAtDesc(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
}

// Not wired to any route yet in Phase 3 (V1 role policy is org-scoped, not
// per-user, for /admin/sessions — see ROLE_POLICY in
// PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md). Kept here because the
// repository is the natural place for it and a future per-user view
// (coach->trainee assignments, a spokesperson's own history) will need
// exactly this shape.
//
// Same index reasoning as listSessionsByOrganization: two bare equality
// filters (organization_id, user_id) don't need a composite index, but
// adding orderBy on top of them would. So no `.limit()` at the Firestore
// level either (limiting before sorting would return an arbitrary N
// matches, not the N most recent) — fetch all matches for the pair (small
// by construction: one user within one org), sort, then slice.
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
  const snap = await admin
    .firestore()
    .collection(COLLECTION)
    .where("organization_id", "==", organizationId)
    .where("user_id", "==", userId)
    .get();
  const sessions = snap.docs
    .map((d) => parseSessionRecord(d.id, d.data()))
    .filter((s): s is SessionRecord => s !== null);
  return sortByStartedAtDesc(sessions).slice(0, limit);
}
