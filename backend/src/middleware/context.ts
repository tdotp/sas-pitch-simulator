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
import { resolveAppContext, type ContextResolution } from "../services/context.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appContext?: AppContext;
    }
  }
}

export type ContextResolver = (
  userId: string,
  email: string | null,
  requestedOrganizationId: string | null
) => Promise<ContextResolution>;

// A client MAY request which of its own organizations it wants as context
// via ?organization_id=... — this is read here and handed to the resolver
// as a SELECTION, never trusted as authority: resolveAppContext verifies
// it against the caller's real, active memberships before honoring it.
function readRequestedOrganizationId(req: Request): string | null {
  const raw = req.query.organization_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

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

    let resolution: ContextResolution;
    try {
      resolution = await resolve(auth.uid, auth.email, readRequestedOrganizationId(req));
    } catch (err) {
      // Fail closed: a Firestore/dependency failure must never fall
      // through to next() with no context. Log internally, respond with a
      // generic, controlled error — never the raw error message/stack.
      console.error("[requireMembership] resolve() falló:", (err as Error).message);
      res.status(503).json({ error: "No se pudo resolver tu organización. Intenta de nuevo." });
      return;
    }

    switch (resolution.type) {
      case "ok":
        req.appContext = resolution.context;
        next();
        return;

      case "no_membership":
        // Firebase user known and allowlisted, but no active, eligible
        // Membership: reject rather than silently falling back to a
        // default organization/role. Distinguishable from the Phase 1
        // allowlist 403 by its message.
        res.status(403).json({ error: "Tu usuario no pertenece a ninguna organización" });
        return;

      case "selection_required":
        // More than one eligible organization and none was requested —
        // never pick arbitrarily. 409 Conflict: the request as given is
        // ambiguous, not unauthorized.
        res.status(409).json({
          error: "Perteneces a varias organizaciones; especifica organization_id",
          organization_ids: resolution.organizationIds,
        });
        return;

      case "forbidden_organization":
        // organization_id was requested but is not one of the caller's
        // own eligible memberships — the id is a selection, never an
        // authority, so this is rejected rather than honored.
        res.status(403).json({ error: "No perteneces a la organización solicitada" });
        return;
    }
  };
}

export const requireMembership = createRequireMembership();
