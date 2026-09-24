// Fase 8 — REQUEST_ID_POLICY. Generated backend-side (never trusted from a
// client header — an id a caller supplies isn't a reliable correlation key,
// and honoring one would let a client forge collisions), available for the
// whole request lifecycle via req.id, and read by
// middleware/requestLogging.ts and any handler that wants to correlate its
// own logs. No distributed tracing — a plain UUID is enough for this phase.
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

export function requestId(req: Request, _res: Response, next: NextFunction): void {
  req.id = randomUUID();
  next();
}
