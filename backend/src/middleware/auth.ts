// Real authentication: verifies the Firebase ID token sent as
// `Authorization: Bearer <token>`.
//
// Order: Bearer present & well-formed -> verifyIdToken -> uid/email verified.
//   - missing/malformed header, or an invalid/expired token -> 401
//   - valid token -> next(), with req.auth = { uid, email }
//
// This is identity ONLY, never authorization. Whether this uid is actually
// allowed to do anything is decided downstream by requireMembership
// (Organization/Membership/Role — Phase 2) and requireAnyRole (Phase 3),
// never here.
//
// HISTORY: through Phase 2, this middleware ALSO enforced a temporary
// AUTH_ALLOWED_EMAILS allowlist (because Firebase's email/password provider
// lets anyone with the public apiKey self-register, so a verified token
// alone didn't imply access). Phase 3 retired that allowlist: every
// sensitive route now requires requireMembership too, and a self-registered
// stranger has no AppUser/Membership record, so they 403 there instead —
// same protection, one system instead of two. See ALLOWLIST_DECISION in
// PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md.

import type { NextFunction, Request, Response } from "express";
import admin from "firebase-admin";

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

    req.auth = { uid: decoded.uid, email: decoded.email ?? null };
    next();
  };
}

export const requireAuth = createRequireAuth();
