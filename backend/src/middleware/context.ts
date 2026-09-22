// Attaches req.appContext (Phase 2: Organization + Role) after requireAuth
// has already verified the Firebase ID token and the allowlist. Mirrors
// middleware/auth.ts's shape: an injectable resolver so tests don't need
// real Firestore, and a default instance wired to the real resolver for
// production use.
//
// This middleware does NOT do resource-level authorization (no tenant
// isolation, no per-endpoint RBAC) — it only resolves and exposes a
// trustworthy context. Applying it to protect specific resources is
// Phase 3.
import type { NextFunction, Request, Response } from "express";
import type { AppContext } from "../types.js";
import { resolveAppContext } from "../services/context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appContext?: AppContext;
    }
  }
}

export type ContextResolver = (userId: string, email: string | null) => Promise<AppContext | null>;

export function createRequireMembership(resolve: ContextResolver = resolveAppContext) {
  return async function requireMembership(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // requireAuth must run before this middleware and set req.auth. If it
    // didn't (wiring bug), fail closed rather than resolving membership
    // for an unverified identity.
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: "No autorizado" });
      return;
    }

    const context = await resolve(auth.uid, auth.email);
    if (!context) {
      // Explicit, safe behavior for "Firebase user known and allowlisted,
      // but no active Membership": reject rather than silently falling
      // back to a default organization/role. Distinguishable from the
      // Phase 1 allowlist 403 by its message.
      res.status(403).json({ error: "Tu usuario no pertenece a ninguna organización" });
      return;
    }

    req.appContext = context;
    next();
  };
}

export const requireMembership = createRequireMembership();
