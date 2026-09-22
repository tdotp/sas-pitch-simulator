// HTTP API. Two lanes:
//  - fast: POST /session/start  → signed URL + agent overrides (voice convo)
//  - slow: POST /session/end    → metrics + Claude Sonnet evaluation + persist
//
// Phase 3: every sensitive route requires requireAuth + requireMembership
// (Firebase token + real Organization/Membership, never data the client
// sends). Role/ownership checks are layered on top per route — see
// PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { assertElevenReady, assertOpenRouterReady, config } from "./config.js";
import { requireAuth } from "./middleware/auth.js";
import { requireMembership } from "./middleware/context.js";
import { requireAnyRole } from "./middleware/roles.js";
import type { SessionRecord, StartSessionRequest, TargetMode, TranscriptTurn } from "./types.js";
import { getSignedUrl } from "./services/elevenlabs.js";
import { computeMetrics } from "./services/metrics.js";
import { evaluatePitch } from "./services/evaluator.js";
import { isAuthReady } from "./firebase.js";
import {
  createSession,
  claimSessionForEvaluation,
  markEvaluationFailed,
  markPersistenceFailed,
  persistCompletedResult,
  listSessionsByOrganization,
} from "./repositories/sessions.js";

const VALID_TARGETS: TargetMode[] = ["generic", "davivienda", "grupo_aval"];

export const router = Router();

router.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    eleven_ready: assertElevenReady() === null,
    openrouter_ready: assertOpenRouterReady() === null,
    // Firebase Admin initialized (i.e. admin.auth().verifyIdToken() can
    // work). false here means every authenticated route will 401
    // regardless of a valid ID token — surface it before it's a silent
    // outage. Independent of Firestore/PERSISTENCE_DISABLED.
    auth_ready: isAuthReady(),
    time: new Date().toISOString(),
  });
});

// Everything below costs real ElevenLabs/OpenRouter credits per call, so it's
// gated by a shared token (sent by our own frontend, not a real secret — it
// ships in the public bundle) plus a per-IP rate limit. Together they stop
// casual/opportunistic abuse of the bare backend URL without adding any
// perceptible latency (both checks run before any external API call).
function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!config.apiSharedToken) return next(); // not configured -> open (local dev)
  if (req.header("x-app-token") === config.apiSharedToken) return next();
  res.status(401).json({ error: "No autorizado" });
}

const limiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intenta de nuevo en un minuto." },
});

router.use(requireToken, limiter);

// ── FAST LANE ─────────────────────────────────────────────
router.post(
  "/session/start",
  requireAuth,
  requireMembership,
  async (req: Request, res: Response) => {
    const elevenErr = assertElevenReady();
    if (elevenErr) return res.status(503).json({ error: elevenErr });

    const body = req.body as Partial<StartSessionRequest>;
    const target = body.target_mode;
    if (!target || !VALID_TARGETS.includes(target)) {
      return res
        .status(400)
        .json({ error: `target_mode inválido. Usa: ${VALID_TARGETS.join(", ")}` });
    }

    // Identity AND tenant come ONLY from the verified token + resolved
    // Membership — never from the request body. A user without a valid
    // Membership never reaches this handler (requireMembership rejects
    // first).
    const auth = req.auth!;
    const context = req.appContext!;

    // Split so each failure maps to the right status per the error
    // taxonomy (Phase 4): 502 for the external provider (ElevenLabs),
    // 503 for our own backing dependency (Firestore) — and neither leaks
    // the raw error message to the client.
    let signed;
    try {
      signed = await getSignedUrl(target, body.voice_gender);
    } catch (err) {
      console.error("[/session/start] getSignedUrl falló:", (err as Error).message);
      return res.status(502).json({ error: "No se pudo iniciar la sesión de voz. Intenta de nuevo." });
    }

    const session: SessionRecord = {
      session_id: randomUUID(),
      user_id: auth.uid,
      user_name: auth.email ?? auth.uid,
      organization_id: context.organizationId,
      target_mode: target,
      voice_gender: signed.voice_gender,
      voice_id: signed.voice_id,
      status: "in_progress",
      started_at: new Date().toISOString(),
      owner_uid: auth.uid,
    };

    try {
      // AWAITED (not fire-and-forget, unlike the Phase 1 version): the
      // /session/end ownership+tenant check reads this record BACK from
      // persistence, so it must actually exist there before the caller
      // can possibly call /session/end. This is the one Firestore write
      // on the critical path in the whole app, by design — it's a single
      // small document write, not a page load.
      await createSession(session);
    } catch (err) {
      console.error("[/session/start] createSession falló:", (err as Error).message);
      return res.status(503).json({ error: "No se pudo guardar tu sesión. Intenta de nuevo." });
    }

    res.json({
      session_id: session.session_id,
      target_mode: target,
      agent_id: signed.agent_id,
      signed_url: signed.signed_url,
      voice_id: signed.voice_id,
      voice_gender: signed.voice_gender,
      overrides: signed.overrides,
    });
  }
);

// ── SLOW LANE ─────────────────────────────────────────────
//
// Phase 4 lifecycle (see PHASE_04_SESSION_LIFECYCLE_REPORT.md):
//   claimSessionForEvaluation  — atomic ownership+tenant+state check AND
//                                 the in_progress -> evaluating transition,
//                                 in one Firestore transaction. Handles
//                                 idempotency (already completed -> return
//                                 the persisted result, no re-evaluation)
//                                 and concurrency (a second concurrent
//                                 request sees "evaluating" and is
//                                 rejected, never runs a second evaluation).
//   evaluatePitch              — OpenRouter call, its own timeout + one
//                                 bounded transient retry (evaluator.ts).
//   persistCompletedResult     — the ONE write that makes a session
//                                 durably "completed" (result + status
//                                 together, atomic per Firestore semantics).
// Every failure path writes an EXPLICIT terminal-ish status
// (evaluation_failed / persistence_failed) instead of leaving the
// session silently "in_progress" or claiming success the client can't
// actually trust.
router.post(
  "/session/end",
  requireAuth,
  requireMembership,
  async (req: Request, res: Response) => {
    const orErr = assertOpenRouterReady();
    if (orErr) return res.status(503).json({ error: orErr });

    const { session_id, transcript, duration_seconds } = req.body as {
      session_id?: string;
      transcript?: TranscriptTurn[];
      duration_seconds?: number;
    };

    if (!session_id) {
      return res.status(400).json({ error: "session_id requerido" });
    }
    if (!Array.isArray(transcript) || transcript.length === 0) {
      return res.status(400).json({ error: "transcript vacío o inválido" });
    }
    const duration = Number.isFinite(duration_seconds)
      ? Math.max(0, Math.round(duration_seconds as number))
      : 0;

    let claim: Awaited<ReturnType<typeof claimSessionForEvaluation>>;
    try {
      claim = await claimSessionForEvaluation({
        sessionId: session_id,
        ownerUid: req.auth!.uid,
        organizationId: req.appContext!.organizationId,
      });
    } catch (err) {
      console.error("[/session/end] claimSessionForEvaluation falló:", (err as Error).message);
      return res.status(503).json({ error: "No se pudo verificar la sesión. Intenta de nuevo." });
    }

    // Ownership + tenant (Phase 3, still uniform 404 — folded into
    // claimSessionForEvaluation's "not_found" outcome, see its comment)
    // and any other unclaimable state.
    if (claim.outcome === "not_found") {
      return res.status(404).json({ error: "Sesión no encontrada" });
    }
    if (claim.outcome === "wrong_state") {
      // e.g. abandoned: a real session the caller owns, but it can't be
      // completed through the normal flow anymore.
      return res.status(409).json({ error: "Esta sesión ya no puede completarse" });
    }
    if (claim.outcome === "in_progress_elsewhere") {
      // A concurrent /session/end (or a very fast retry) already claimed
      // it and is evaluating right now — never start a second evaluation.
      return res.status(409).json({ error: "Esta sesión ya se está evaluando" });
    }
    if (claim.outcome === "already_completed") {
      // IDEMPOTENCY: reconstruct the response from what's persisted —
      // never re-run the evaluation for a session that's already done.
      const s = claim.session;
      if (!s.metrics || !s.evaluation) {
        console.error(
          "[/session/end] sesión 'completed' sin resultado persistido:",
          session_id
        );
        return res.status(503).json({ error: "No se pudo recuperar el resultado. Intenta de nuevo." });
      }
      return res.json({
        session_id,
        target_mode: s.target_mode,
        metrics: s.metrics,
        evaluation: s.evaluation,
      });
    }

    // claim.outcome === "claimed": we now exclusively hold "evaluating".
    const target: TargetMode = claim.session.target_mode;
    const metrics = computeMetrics(transcript, duration);

    let evaluation;
    try {
      evaluation = await evaluatePitch({
        sessionId: session_id,
        target,
        transcript,
        durationSeconds: duration,
        metrics,
      });
    } catch (err) {
      const reason = (err as Error).message;
      console.error("[/session/end] evaluatePitch falló:", reason);
      try {
        await markEvaluationFailed(session_id, reason);
      } catch (markErr) {
        // The session is stuck in "evaluating" if even this fails — same
        // class of recoverable-but-stuck state as an abandoned session;
        // see KNOWN_LIMITATIONS in PHASE_04_SESSION_LIFECYCLE_REPORT.md.
        console.error("[/session/end] markEvaluationFailed también falló:", (markErr as Error).message);
      }
      return res.status(502).json({ error: "No se pudo evaluar la sesión. Intenta de nuevo más tarde." });
    }

    try {
      await persistCompletedResult(session_id, {
        duration_seconds: duration,
        transcript,
        metrics,
        evaluation,
      });
    } catch (err) {
      console.error("[/session/end] persistCompletedResult falló:", (err as Error).message);
      try {
        await markPersistenceFailed(session_id, (err as Error).message);
      } catch (markErr) {
        console.error("[/session/end] markPersistenceFailed también falló:", (markErr as Error).message);
      }
      // Deliberately NOT 200: the evaluation ran, but nothing durable
      // exists to back that up yet — the client must not be told this
      // succeeded. A retry will re-claim (persistence_failed is
      // claimable) and re-run the evaluation, since nothing was saved.
      return res.status(503).json({ error: "No se pudo guardar tu resultado. Intenta de nuevo." });
    }

    res.json({ session_id, target_mode: target, metrics, evaluation });
  }
);

// Debug: metrics only (no LLM). No role restriction — any authenticated,
// allowlisted-by-Membership user may use it; it doesn't read or persist
// any tenant resource.
router.post(
  "/metrics/analyze",
  requireAuth,
  requireMembership,
  (req: Request, res: Response) => {
    const { transcript, duration_seconds } = req.body as {
      transcript?: TranscriptTurn[];
      duration_seconds?: number;
    };
    if (!Array.isArray(transcript)) {
      return res.status(400).json({ error: "transcript inválido" });
    }
    res.json(computeMetrics(transcript, Number(duration_seconds) || 0));
  }
);

// P0 closed (Phase 3): sessions are now returned ONLY for the caller's
// resolved organization (req.appContext.organizationId — see
// requireMembership; ?organization_id lets a multi-org AGENCY_ADMIN pick
// among ITS OWN verified memberships, exactly like GET /me, never an
// arbitrary org). SPOKESPERSON is excluded entirely by requireAnyRole.
// V1 role policy (see ROLE_POLICY in
// PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md): AGENCY_ADMIN/CLIENT_ADMIN/
// COACH can all read their resolved organization's sessions; no
// per-assignment filtering yet (COACH sees the whole org, not just
// assigned trainees — documented as V1, not a bug).
router.get(
  "/admin/sessions",
  requireAuth,
  requireMembership,
  requireAnyRole("AGENCY_ADMIN", "CLIENT_ADMIN", "COACH"),
  async (req: Request, res: Response) => {
    const context = req.appContext!;
    try {
      const sessions = await listSessionsByOrganization(context.organizationId);
      res.json({ organization_id: context.organizationId, sessions });
    } catch (err) {
      console.error("[/admin/sessions]", (err as Error).message);
      res.status(503).json({ error: "No se pudieron obtener las sesiones. Intenta de nuevo." });
    }
  }
);

// Phase 2: exposes the server-resolved identity/organization/role context.
// Deliberately does NOT gate or filter any other resource on its own —
// organizationId/role always come from Firestore Membership data via
// requireMembership, never from the client.
//
// Contract: with 0 eligible memberships -> 403; exactly 1 -> 200 with that
// context automatically; 2+ without ?organization_id -> 409 (ambiguous,
// never picked arbitrarily) with the list of organization_ids the caller
// may choose from; ?organization_id=X where X is one of the caller's own
// eligible memberships -> 200 for X; ?organization_id=X the caller does
// NOT belong to -> 403 (a requested organization is a selection among the
// caller's real memberships, never an authority). "Eligible" requires the
// AppUser, the Membership, AND its Organization to all be active — see
// services/context.ts.
router.get(
  "/me",
  requireAuth,
  requireMembership,
  (req: Request, res: Response) => {
    res.json(req.appContext);
  }
);
