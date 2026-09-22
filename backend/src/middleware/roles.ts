// Centralized role authorization (Phase 3). Must run AFTER requireAuth +
// requireMembership — it reads req.appContext.role, which is only ever
// set by requireMembership from a verified Firestore Membership, never
// from anything the client sends. This is the single place role checks
// live; routes.ts must never inline `if (role === ...)`.
import type { NextFunction, Request, Response } from "express";
import type { Role } from "../types.js";

export function requireAnyRole(...allowed: Role[]) {
  return function requireRole(req: Request, res: Response, next: NextFunction): void {
    const context = req.appContext;
    if (!context) {
      // Wiring bug (requireMembership didn't run first) — fail closed the
      // same way requireMembership itself does when req.auth is missing.
      res.status(401).json({ error: "No autorizado" });
      return;
    }
    if (!allowed.includes(context.role)) {
      res.status(403).json({ error: "Tu rol no tiene acceso a este recurso" });
      return;
    }
    next();
  };
}
