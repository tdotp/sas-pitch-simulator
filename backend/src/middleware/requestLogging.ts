// Fase 8 — HTTP_REQUEST_LOGGING. One structured event per request, emitted
// on `res.on("finish")` so status_code/duration_ms are final and
// organization_id/user_id/role are populated if requireAuth/
// requireMembership already ran by then (they're `undefined` — simply
// omitted by logEvent — for pre-auth requests or ones that 401 before
// reaching them, which is itself informative: see the "no auth resolved"
// test in routes.test.ts).
//
// Deliberately NEVER reads req.body, req.headers, or the query string —
// only method, req.path (the route path, not the raw URL — no query
// string, so no risk of a secret passed as a query param leaking) and the
// response's own status/timing.
import type { NextFunction, Request, Response } from "express";
import { logEvent, elapsedMs } from "../observability/log.js";

export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    logEvent({
      event: "http_request",
      request_id: req.id,
      method: req.method,
      endpoint: req.path,
      status_code: res.statusCode,
      duration_ms: elapsedMs(start),
      organization_id: req.appContext?.organizationId,
      user_id: req.auth?.uid,
      role: req.appContext?.role,
      outcome: res.statusCode < 400 ? "success" : "failure",
    });
  });
  next();
}
