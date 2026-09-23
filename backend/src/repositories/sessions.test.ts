// Unit tests for the session lifecycle repository. Uses the in-memory
// fallback (isPersistenceEnabled mocked to false) so the exact same
// decision logic (decideClaim, transitions) that runs against Firestore in
// production is exercised without needing a real Firestore transaction —
// consistent with the "no repository-level Firestore mocking" approach
// already documented as a scoped limitation in Phases 2-3. Each test uses
// a unique session_id since the in-memory store is module-level and not
// reset between tests.
import { describe, it, expect, vi } from "vitest";

vi.mock("../firebase.js", () => ({ isPersistenceEnabled: () => false }));

import {
  createSession,
  getSessionById,
  claimSessionForEvaluation,
  markEvaluationFailed,
  markPersistenceFailed,
  persistCompletedResult,
  markAbandoned,
  listEvaluatingSessionsOlderThan,
} from "./sessions.js";
import type { SessionRecord } from "../types.js";

let counter = 0;
function newSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  counter += 1;
  return {
    session_id: `session-${counter}`,
    user_id: "uid-1",
    user_name: "user@test.com",
    organization_id: "org-1",
    target_mode: "generic",
    voice_gender: "male",
    voice_id: "voice-1",
    status: "in_progress",
    started_at: "2026-01-01T00:00:00.000Z",
    owner_uid: "uid-1",
    ...overrides,
  };
}

const evaluation = {
  session_id: "x",
  target_mode: "generic",
  overall_score: 80,
} as unknown as import("../types.js").EvaluationResult;

const metrics = {
  word_count: 10,
  words_per_minute: 100,
  filler_words_total: 0,
  filler_words_items: {},
  repetition_count: 0,
  repetition_items: [],
  long_pauses_count: 0,
  used_numbers: true,
  numbers_detected: [],
  has_cta: true,
} as import("../types.js").SpeechMetrics;

describe("createSession / getSessionById", () => {
  it("round-trips a session in the in_progress state", async () => {
    const s = newSession();
    await createSession(s);
    const read = await getSessionById(s.session_id);
    expect(read?.status).toBe("in_progress");
    expect(read?.organization_id).toBe("org-1");
    expect(read?.owner_uid).toBe("uid-1");
  });
});

describe("claimSessionForEvaluation", () => {
  it("claims an in_progress session owned by the caller in the right org", async () => {
    const s = newSession();
    await createSession(s);

    const claim = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });

    expect(claim.outcome).toBe("claimed");
    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("evaluating");
  });

  it("returns not_found for an unknown session_id", async () => {
    const claim = await claimSessionForEvaluation({
      sessionId: "does-not-exist",
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(claim.outcome).toBe("not_found");
  });

  it("returns not_found when the owner_uid doesn't match", async () => {
    const s = newSession();
    await createSession(s);
    const claim = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "someone-else",
      organizationId: "org-1",
    });
    expect(claim.outcome).toBe("not_found");
  });

  it("returns not_found when the organization_id doesn't match the request's authorized context", async () => {
    const s = newSession({ organization_id: "org-a" });
    await createSession(s);
    const claim = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-b",
    });
    expect(claim.outcome).toBe("not_found");
  });

  it("returns in_progress_elsewhere for a session already being evaluated (concurrency guard)", async () => {
    const s = newSession();
    await createSession(s);
    const first = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(first.outcome).toBe("claimed");

    const second = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(second.outcome).toBe("in_progress_elsewhere");
  });

  it("returns already_completed with the persisted result for a completed session — no re-claim", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await persistCompletedResult(s.session_id, {
      duration_seconds: 42,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });

    const claim = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(claim.outcome).toBe("already_completed");
    if (claim.outcome === "already_completed") {
      expect(claim.session.evaluation).toEqual(evaluation);
      expect(claim.session.metrics).toEqual(metrics);
    }
  });

  it("returns wrong_state for an abandoned session — cannot be claimed normally", async () => {
    const s = newSession();
    await createSession(s);
    const abandon = await markAbandoned(s.session_id);
    expect(abandon.outcome).toBe("abandoned");

    const claim = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(claim.outcome).toBe("wrong_state");
    if (claim.outcome === "wrong_state") {
      expect(claim.status).toBe("abandoned");
    }
  });

  it("re-claims an evaluation_failed session (retry path)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await markEvaluationFailed(s.session_id, "OpenRouter timeout");

    const retry = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(retry.outcome).toBe("claimed");
  });

  it("re-claims a persistence_failed session (retry path)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await markPersistenceFailed(s.session_id, "firestore write failed");

    const retry = await claimSessionForEvaluation({
      sessionId: s.session_id,
      ownerUid: "uid-1",
      organizationId: "org-1",
    });
    expect(retry.outcome).toBe("claimed");
  });
});

describe("markEvaluationFailed / markPersistenceFailed", () => {
  it("moves evaluating -> evaluation_failed with a sanitized reason", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    await markEvaluationFailed(s.session_id, "OpenRouter evaluation failed (503): boom");
    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("evaluation_failed");
    expect(after?.failure_reason).toContain("503");
  });

  it("truncates an overly long failure reason", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    await markEvaluationFailed(s.session_id, "x".repeat(10_000));
    const after = await getSessionById(s.session_id);
    expect((after?.failure_reason ?? "").length).toBeLessThanOrEqual(300);
  });

  it("moves evaluating -> persistence_failed", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    await markPersistenceFailed(s.session_id, "firestore write failed");
    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("persistence_failed");
  });
});

describe("persistCompletedResult", () => {
  it("moves evaluating -> completed with transcript, metrics and evaluation attached", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    await persistCompletedResult(s.session_id, {
      duration_seconds: 90,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });

    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("completed");
    expect(after?.duration_seconds).toBe(90);
    expect(after?.metrics).toEqual(metrics);
    expect(after?.evaluation).toEqual(evaluation);
    expect(after?.transcript?.full).toContain("hola");
    expect(after?.ended_at).toBeTruthy();
  });

  it("serializes the transcript with neutral role labels, never a fixed human name (SANDRA)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    await persistCompletedResult(s.session_id, {
      duration_seconds: 90,
      transcript: [
        { role: "agent", text: "pregunta" },
        { role: "user", text: "respuesta" },
      ],
      metrics,
      evaluation,
    });

    const after = await getSessionById(s.session_id);
    expect(after?.transcript?.full).not.toContain("SANDRA");
    expect(after?.transcript?.full).toContain("VOCERO: respuesta");
    expect(after?.transcript?.full).toContain("ENTREVISTADOR: pregunta");
  });
});

describe("markAbandoned", () => {
  it("moves in_progress -> abandoned", async () => {
    const s = newSession();
    await createSession(s);
    const result = await markAbandoned(s.session_id);
    expect(result.outcome).toBe("abandoned");
    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("abandoned");
  });

  it("refuses to abandon a session that is already evaluating (no race with a real /session/end)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    const result = await markAbandoned(s.session_id);
    expect(result.outcome).toBe("not_abandonable");
    if (result.outcome === "not_abandonable") {
      expect(result.status).toBe("evaluating");
    }
  });

  it("refuses to abandon an already-completed session", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await persistCompletedResult(s.session_id, {
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });

    const result = await markAbandoned(s.session_id);
    expect(result.outcome).toBe("not_abandonable");
  });

  it("returns not_found for an unknown session", async () => {
    const result = await markAbandoned("does-not-exist");
    expect(result.outcome).toBe("not_found");
  });
});

describe("PASS_WITH_FIXES: guarded exits from evaluating (compare-and-set)", () => {
  // The fix this round: persistCompletedResult / markEvaluationFailed /
  // markPersistenceFailed used to write unconditionally and could
  // overwrite ANY status. They must now only apply from "evaluating" —
  // everything else is preserved untouched and reported via
  // `currentStatus`, never silently clobbered.

  it("1. completed + markEvaluationFailed -> still completed (rejected, not applied)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await persistCompletedResult(s.session_id, {
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });

    const result = await markEvaluationFailed(s.session_id, "OPENROUTER_TIMEOUT");
    expect(result).toEqual({ applied: false, currentStatus: "completed" });

    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("completed");
    expect(after?.evaluation).toEqual(evaluation);
  });

  it("2. completed + markPersistenceFailed -> still completed (rejected, not applied)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await persistCompletedResult(s.session_id, {
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });

    const result = await markPersistenceFailed(s.session_id, "FIRESTORE_WRITE_FAILED");
    expect(result).toEqual({ applied: false, currentStatus: "completed" });

    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("completed");
    expect(after?.metrics).toEqual(metrics);
  });

  it("3. abandoned + persistCompletedResult -> rejected, stays abandoned", async () => {
    const s = newSession();
    await createSession(s);
    const abandon = await markAbandoned(s.session_id);
    expect(abandon.outcome).toBe("abandoned");

    const result = await persistCompletedResult(s.session_id, {
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });
    expect(result).toEqual({ applied: false, currentStatus: "abandoned" });

    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("abandoned");
    expect(after?.evaluation).toBeUndefined();
  });

  it("4. evaluation_failed + persistCompletedResult without a new claim -> rejected", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await markEvaluationFailed(s.session_id, "OPENROUTER_5XX");

    const result = await persistCompletedResult(s.session_id, {
      duration_seconds: 10,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });
    expect(result).toEqual({ applied: false, currentStatus: "evaluation_failed" });

    const after = await getSessionById(s.session_id);
    expect(after?.status).toBe("evaluation_failed");
    expect(after?.evaluation).toBeUndefined();
  });

  it("5. completed + a later attempt to mark persistence_failed leaves the persisted result fully intact", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });
    await persistCompletedResult(s.session_id, {
      duration_seconds: 55,
      transcript: [{ role: "user", text: "el pitch completo" }],
      metrics,
      evaluation,
    });
    const before = await getSessionById(s.session_id);

    // Simulates the "ambiguous ack" case: caller thinks the write failed
    // and tries to mark persistence_failed anyway.
    const result = await markPersistenceFailed(s.session_id, "FIRESTORE_WRITE_FAILED");
    expect(result).toEqual({ applied: false, currentStatus: "completed" });

    const after = await getSessionById(s.session_id);
    expect(after).toEqual(before); // byte-for-byte unchanged
    expect(after?.status).toBe("completed");
    expect(after?.evaluation).toEqual(evaluation);
    expect(after?.metrics).toEqual(metrics);
    expect(after?.duration_seconds).toBe(55);
  });

  it("still applies normally from evaluating (the common, non-conflicting case)", async () => {
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    const result = await persistCompletedResult(s.session_id, {
      duration_seconds: 20,
      transcript: [{ role: "user", text: "hola" }],
      metrics,
      evaluation,
    });
    expect(result).toEqual({ applied: true });
  });

  it("reports currentStatus: null for a session that doesn't exist at all", async () => {
    const result = await markEvaluationFailed("does-not-exist", "OPENROUTER_TIMEOUT");
    expect(result).toEqual({ applied: false, currentStatus: null });
  });
});

// Fase 7: STALE_EVALUATING_POLICY — the read side of the stale-evaluating
// recovery sweep (scripts/mark-stale-evaluating-sessions.ts). Backdates
// `updated_at` via fake system time rather than passing it directly, since
// createSession always stamps updated_at with the CURRENT time (both the
// Firestore and in-memory paths) — see repositories/sessions.ts.
describe("listEvaluatingSessionsOlderThan", () => {
  it("returns an evaluating session whose updated_at (claim time) is older than the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const s = newSession();
    await createSession(s);
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z")); // 10h later
    const cutoff = new Date("2026-01-01T05:00:00.000Z").toISOString(); // 5h cutoff
    const stale = await listEvaluatingSessionsOlderThan(cutoff);
    vi.useRealTimers();

    expect(stale.map((r) => r.session_id)).toContain(s.session_id);
  });

  it("excludes an evaluating session claimed more recently than the cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const s = newSession();
    await createSession(s);

    vi.setSystemTime(new Date("2026-01-01T04:00:00.000Z")); // claimed at 04:00
    await claimSessionForEvaluation({ sessionId: s.session_id, ownerUid: "uid-1", organizationId: "org-1" });

    const cutoff = new Date("2026-01-01T03:00:00.000Z").toISOString(); // sweep threshold: 03:00
    const stale = await listEvaluatingSessionsOlderThan(cutoff);
    vi.useRealTimers();

    expect(stale.map((r) => r.session_id)).not.toContain(s.session_id);
  });

  it("excludes an in_progress session even if it's old (that's the abandonment sweep's job, not this one)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const s = newSession(); // stays in_progress, never claimed
    await createSession(s);

    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    const cutoff = new Date("2026-01-01T05:00:00.000Z").toISOString();
    const stale = await listEvaluatingSessionsOlderThan(cutoff);
    vi.useRealTimers();

    expect(stale.map((r) => r.session_id)).not.toContain(s.session_id);
  });
});
