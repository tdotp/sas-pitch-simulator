// Phase 1 real authentication: verifies the Firebase ID token sent as
// `Authorization: Bearer <token>` and enforces a temporary email allowlist.
//
// Order (per spec): Bearer present & well-formed -> verifyIdToken -> uid/email
// verified -> allowlist check.
//   - missing/malformed header, or an invalid/expired token -> 401
//   - valid token but email not in AUTH_ALLOWED_EMAILS               -> 403
//
// This is identity, not authorization/roles. Anything beyond "is this a
// known, allowed person" (organizations, membership, RBAC) is out of scope
// for this phase — see KNOWN_LIMITATIONS in PHASE_01_AUTH_IMPLEMENTATION_REPORT.md.

import type { NextFunction, Request, Response } from "express";
import admin from "firebase-admin";
import { config } from "../config.js";

export interface AuthContext {
  uid: string;
  email: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Verifier is injectable so tests don't need a real Firebase project.
export type IdTokenVerifier = (
  idToken: string
) => Promise<{ uid: string; email?: string | null }>;

const defaultVerifier: IdTokenVerifier = async (idToken: string) => {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return { uid: decoded.uid, email: decoded.email ?? null };
};

export function createRequireAuth(verifyIdToken: IdTokenVerifier = defaultVerifier) {
  return async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const header = req.header("authorization") ?? req.header("Authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "No autorizado" });
      return;
    }
    const idToken = header.slice("Bearer ".length).trim();
    if (!idToken) {
      res.status(401).json({ error: "No autorizado" });
      return;
    }

    let decoded: { uid: string; email?: string | null };
    try {
      decoded = await verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: "No autorizado" });
      return;
    }

    const email = (decoded.email ?? "").toLowerCase();
    if (!email || !config.authAllowedEmails.includes(email)) {
      res.status(403).json({ error: "No tienes acceso a esta aplicación" });
      return;
    }

    req.auth = { uid: decoded.uid, email: decoded.email ?? null };
    next();
  };
}

export const requireAuth = createRequireAuth();
