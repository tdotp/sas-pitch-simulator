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
  getSessionById,
  completeSession,
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
    try {
      const signed = await getSignedUrl(target, body.voice_gender);
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

      // AWAITED (not fire-and-forget, unlike the Phase 1 version): the
      // /session/end ownership+tenant check reads this record BACK from
      // persistence, so it must actually exist there before the caller
      // can possibly call /session/end. This is the one Firestore write
      // on the critical path in the whole app, by design — it's a single
      // small document write, not a page load.
      await createSession(session);

      res.json({
        session_id: session.session_id,
        target_mode: target,
        agent_id: signed.agent_id,
        signed_url: signed.signed_url,
        voice_id: signed.voice_id,
        voice_gender: signed.voice_gender,
        overrides: signed.overrides,
      });
    } catch (err) {
      console.error("[/session/start]", (err as Error).message);
      res.status(502).json({ error: (err as Error).message });
    }
  }
);

// ── SLOW LANE ─────────────────────────────────────────────
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

    let stored: SessionRecord | null;
    try {
      stored = await getSessionById(session_id);
    } catch (err) {
      console.error("[/session/end] getSessionById falló:", (err as Error).message);
      return res.status(503).json({ error: "No se pudo verificar la sesión. Intenta de nuevo." });
    }

    // Ownership (Phase 3, persisted — not the Phase 1 in-memory Map
    // anymore): the simplest correct rule per the reviewed spec — the
    // authenticated caller must be the uid that started the session.
    // CLIENT_ADMIN/COACH/AGENCY_ADMIN get NO special bypass here on
    // purpose: administrative access to session RESULTS is a read
    // concern (GET /admin/sessions), not something that should let
    // anyone but the starter mutate/complete a session via this route.
    //
    // A missing session (never existed, wrong id, or a legacy pre-Phase-3
    // doc without organization_id — see LEGACY_SESSION_POLICY) and a
    // session that exists but belongs to someone else both return the
    // SAME 404, deliberately: distinguishing them would let a caller
    // enumerate which session_ids are real but not theirs.
    if (!stored || stored.owner_uid !== req.auth!.uid) {
      return res.status(404).json({ error: "Sesión no encontrada" });
    }

    const target: TargetMode = stored.target_mode;

    try {
      const metrics = computeMetrics(transcript, duration);
      const evaluation = await evaluatePitch({
        sessionId: session_id,
        target,
        transcript,
        durationSeconds: duration,
        metrics,
      });

      // Fire-and-forget is fine for THIS write: tenant/ownership integrity
      // was already durably established by the awaited createSession at
      // /session/start. Worst case on failure here is a session that
      // stays "in_progress" in Firestore with stale results — not a
      // security issue, just a data-completeness one.
      void completeSession(session_id, { duration_seconds: duration, transcript, metrics, evaluation });

      res.json({ session_id, target_mode: target, metrics, evaluation });
    } catch (err) {
      console.error("[/session/end]", (err as Error).message);
      res.status(502).json({ error: (err as Error).message });
    }
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
