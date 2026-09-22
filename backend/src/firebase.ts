// Firebase Admin bootstrap.
//
// Firebase Admin (the app itself, and therefore `admin.auth()` used by the
// auth middleware to verify ID tokens) initializes whenever valid
// credentials are configured, REGARDLESS of PERSISTENCE_DISABLED.
// PERSISTENCE_DISABLED only controls whether Firestore reads/writes happen
// — it must never gate Auth availability. If Firebase isn't configured at
// all (creds pending), both Auth and persistence degrade gracefully (Auth
// verification will fail closed — requireAuth 401s everything).
//
// Session/Organization/User/Membership persistence lives in
// backend/src/repositories/*.ts (Phase 2/3), not here — this module is
// only the Firebase Admin app bootstrap + the two readiness flags other
// modules check (isAuthReady, isPersistenceEnabled).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import admin from "firebase-admin";
import { config } from "./config.js";

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

  // Firebase Admin app: needed for admin.auth().verifyIdToken() (auth
  // middleware), independent of whether Firestore persistence is enabled.
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
    admin.firestore(); // just confirms it's reachable; repositories call it themselves
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
