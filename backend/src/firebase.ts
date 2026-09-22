// Firebase Admin bootstrap + persistence helpers.
//
// Firebase Admin (the app itself, and therefore `admin.auth()` used by the
// Phase 1 auth middleware to verify ID tokens) initializes whenever valid
// credentials are configured, REGARDLESS of PERSISTENCE_DISABLED.
// PERSISTENCE_DISABLED only controls whether Firestore reads/writes happen
// — it must never gate Auth availability. Firestore persistence is OFF the
// critical path anyway: writes are fire-and-forget and never block the
// response. If Firebase isn't configured at all (creds pending), both Auth
// and persistence degrade gracefully (Auth verification will fail closed —
// requireAuth 401s everything — and persistence falls back to console log).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import admin from "firebase-admin";
import { config } from "./config.js";
import type {
  EvaluationResult,
  SessionRecord,
  SpeechMetrics,
  TranscriptTurn,
} from "./types.js";

let db: admin.firestore.Firestore | null = null;
let persistenceEnabled = false;
let authReady = false;

export function initFirebase(): void {
  const path = config.firebase.serviceAccountPath;
  if (!path) {
    console.warn(
      "[firebase] Sin FIREBASE_SERVICE_ACCOUNT_PATH — Firebase Admin desactivado " +
        "(Auth Y Firestore). Los ID tokens no podrán verificarse."
    );
    return;
  }

  // Firebase Admin app: needed for admin.auth().verifyIdToken() (Phase 1
  // auth), independent of whether Firestore persistence is enabled.
  try {
    const serviceAccount = JSON.parse(
      readFileSync(resolve(path), "utf-8")
    ) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: config.firebase.projectId || undefined,
      storageBucket: config.firebase.storageBucket || undefined,
    });
    authReady = true;
    console.log("[firebase] Firebase Admin inicializado (Auth disponible).");
  } catch (err) {
    console.error(
      "[firebase] No se pudo inicializar Firebase Admin (Auth y Firestore " +
        "quedan desactivados):",
      (err as Error).message
    );
    return;
  }

  // From here on, PERSISTENCE_DISABLED governs ONLY Firestore.
  if (config.persistenceDisabled) {
    console.log(
      "[firebase] PERSISTENCE_DISABLED=true — Firestore en modo log (Auth sigue activo)."
    );
    return;
  }

  try {
    db = admin.firestore();
    persistenceEnabled = true;
    console.log("[firebase] Firestore listo. Persistencia activa.");
  } catch (err) {
    console.error("[firebase] No se pudo inicializar Firestore:", (err as Error).message);
  }
}

export function isPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

// Whether admin.auth().verifyIdToken() can be expected to work — i.e.
// Firebase Admin initialized successfully. Exposed via GET /health as
// `auth_ready` so a misconfigured FIREBASE_SERVICE_ACCOUNT_PATH is visible
// before it silently breaks every authenticated route in production.
export function isAuthReady(): boolean {
  return authReady;
}

export async function saveSessionStart(session: SessionRecord): Promise<void> {
  if (!persistenceEnabled || !db) {
    console.log("[firebase:log] session start", session.session_id);
    return;
  }
  try {
    await db
      .collection("sessions")
      .doc(session.session_id)
      .set({ ...session, created_at: admin.firestore.FieldValue.serverTimestamp() });
  } catch (err) {
    console.error("[firebase] saveSessionStart error:", (err as Error).message);
  }
}

export async function saveSessionResult(params: {
  session_id: string;
  duration_seconds: number;
  transcript: TranscriptTurn[];
  metrics: SpeechMetrics;
  evaluation: EvaluationResult;
}): Promise<void> {
  if (!persistenceEnabled || !db) {
    console.log("[firebase:log] session result", params.session_id, {
      overall: params.evaluation.overall_score,
    });
    return;
  }
  try {
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

    await db
      .collection("sessions")
      .doc(params.session_id)
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
  } catch (err) {
    console.error("[firebase] saveSessionResult error:", (err as Error).message);
  }
}

export async function listSessions(limit = 50): Promise<unknown[]> {
  if (!persistenceEnabled || !db) return [];
  const snap = await db
    .collection("sessions")
    .orderBy("created_at", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data());
}
