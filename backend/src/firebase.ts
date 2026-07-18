// Firebase Admin bootstrap + persistence helpers. Persistence is OFF the
// critical path: writes are fire-and-forget and never block the response.
// If Firebase isn't configured (creds pending), we degrade to console logging
// so the whole flow still works locally.

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
let enabled = false;

export function initFirebase(): void {
  if (config.persistenceDisabled) {
    console.log("[firebase] PERSISTENCE_DISABLED=true — usando console log.");
    return;
  }
  const path = config.firebase.serviceAccountPath;
  if (!path) {
    console.warn(
      "[firebase] Sin FIREBASE_SERVICE_ACCOUNT_PATH — persistencia desactivada (modo log)."
    );
    return;
  }
  try {
    const serviceAccount = JSON.parse(
      readFileSync(resolve(path), "utf-8")
    ) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: config.firebase.projectId || undefined,
      storageBucket: config.firebase.storageBucket || undefined,
    });
    db = admin.firestore();
    enabled = true;
    console.log("[firebase] Inicializado. Persistencia activa.");
  } catch (err) {
    console.error(
      "[firebase] No se pudo inicializar; se usará modo log:",
      (err as Error).message
    );
  }
}

export function isPersistenceEnabled(): boolean {
  return enabled;
}

export async function saveSessionStart(session: SessionRecord): Promise<void> {
  if (!enabled || !db) {
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
  if (!enabled || !db) {
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
  if (!enabled || !db) return [];
  const snap = await db
    .collection("sessions")
    .orderBy("created_at", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data());
}
