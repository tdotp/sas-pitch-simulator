// HTTP API. Two lanes:
//  - fast: POST /session/start  → signed URL + agent overrides (voice convo)
//  - slow: POST /session/end    → metrics + Claude Sonnet evaluation + persist
// Firebase writes are fire-and-forget; the report is returned immediately.

import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { assertElevenReady, assertOpenRouterReady, config } from "./config.js";
import { requireAuth } from "./middleware/auth.js";
import type {
  SessionRecord,
  StartSessionRequest,
  TargetMode,
  TranscriptTurn,
} from "./types.js";
import { getSignedUrl } from "./services/elevenlabs.js";
import { computeMetrics } from "./services/metrics.js";
import { evaluatePitch } from "./services/evaluator.js";
import {
  saveSessionResult,
  saveSessionStart,
  listSessions,
} from "./firebase.js";

const VALID_TARGETS: TargetMode[] = ["generic", "davivienda", "grupo_aval"];

// Minimal in-memory store so /session/end knows the target for a session_id
// without trusting the client. Fine for a single-user MVP; swap for Firestore
// read if you later need multi-instance.
const sessions = new Map<string, SessionRecord>();

export const router = Router();

router.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    eleven_ready: assertElevenReady() === null,
    openrouter_ready: assertOpenRouterReady() === null,
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
router.post("/session/start", requireAuth, async (req: Request, res: Response) => {
  const elevenErr = assertElevenReady();
  if (elevenErr) return res.status(503).json({ error: elevenErr });

  const body = req.body as Partial<StartSessionRequest>;
  const target = body.target_mode;
  if (!target || !VALID_TARGETS.includes(target)) {
    return res
      .status(400)
      .json({ error: `target_mode inválido. Usa: ${VALID_TARGETS.join(", ")}` });
  }

  // Identity comes ONLY from the verified token — never from the request
  // body. `user_id`/`user_name` sent by the client are ignored.
  const auth = req.auth!;
  try {
    const signed = await getSignedUrl(target, body.voice_gender);
    const session: SessionRecord = {
      session_id: randomUUID(),
      user_id: auth.uid,
      user_name: auth.email ?? auth.uid,
      target_mode: target,
      voice_gender: signed.voice_gender,
      voice_id: signed.voice_id,
      status: "in_progress",
      started_at: new Date().toISOString(),
      // Not part of SessionRecord's public shape persisted downstream;
      // kept only in the in-memory Map for the ownership check below.
      owner_uid: auth.uid,
    };
    sessions.set(session.session_id, session);
    void saveSessionStart(session); // fire-and-forget

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
});

// ── SLOW LANE ─────────────────────────────────────────────
router.post("/session/end", requireAuth, async (req: Request, res: Response) => {
  const orErr = assertOpenRouterReady();
  if (orErr) return res.status(503).json({ error: orErr });

  const {
    session_id,
    transcript,
    duration_seconds,
    target_mode: bodyTarget,
  } = req.body as {
    session_id?: string;
    transcript?: TranscriptTurn[];
    duration_seconds?: number;
    target_mode?: TargetMode;
  };

  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ error: "transcript vacío o inválido" });
  }
  const duration = Number.isFinite(duration_seconds)
    ? Math.max(0, Math.round(duration_seconds as number))
    : 0;

  const stored = session_id ? sessions.get(session_id) : undefined;

  // Ownership check (Phase 1, temporary): if we still have the in-memory
  // record for this session_id, only its starter may end it. This relies
  // on the same non-durable `sessions` Map as /session/start — it is lost
  // on process restart, so it is a protection, not a guarantee. Durable
  // ownership (Firestore-backed) lands in Phase 4; this P0 stays open
  // until then.
  if (stored?.owner_uid && stored.owner_uid !== req.auth!.uid) {
    return res.status(403).json({ error: "No tienes acceso a esta sesión" });
  }

  const target: TargetMode =
    stored?.target_mode ??
    (bodyTarget && VALID_TARGETS.includes(bodyTarget) ? bodyTarget : "generic");
  const sid = session_id ?? randomUUID();

  try {
    const metrics = computeMetrics(transcript, duration);
    const evaluation = await evaluatePitch({
      sessionId: sid,
      target,
      transcript,
      durationSeconds: duration,
      metrics,
    });

    // Persist without blocking the response.
    void saveSessionResult({
      session_id: sid,
      duration_seconds: duration,
      transcript,
      metrics,
      evaluation,
    });

    if (stored) {
      stored.status = "completed";
      stored.ended_at = new Date().toISOString();
      stored.duration_seconds = duration;
    }

    res.json({ session_id: sid, target_mode: target, metrics, evaluation });
  } catch (err) {
    console.error("[/session/end]", (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

// Debug: metrics only (no LLM).
router.post("/metrics/analyze", requireAuth, (req: Request, res: Response) => {
  const { transcript, duration_seconds } = req.body as {
    transcript?: TranscriptTurn[];
    duration_seconds?: number;
  };
  if (!Array.isArray(transcript)) {
    return res.status(400).json({ error: "transcript inválido" });
  }
  res.json(computeMetrics(transcript, Number(duration_seconds) || 0));
});

// KNOWN_LIMITATION / OPEN_P0 (Phase 1): this route only requires a valid,
// allowlisted user — it is NOT scoped by role or ownership, so any allowed
// user can read every session (all transcripts, all scores) via this
// endpoint. Real RBAC lands in Phases 2–3 (Organization/Membership). Do not
// treat this as fixed.
router.get("/admin/sessions", requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json({ sessions: await listSessions() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
