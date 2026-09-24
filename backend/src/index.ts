import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { router } from "./routes.js";
import { initFirebase } from "./firebase.js";
import { TRUSTED_PROXY_HOPS } from "./trustProxy.js";

const app = express();

// Fase 8 PASS_WITH_FIXES (P1): without this, Express ignores
// X-Forwarded-For entirely and req.ip is always Caddy's own container
// address for every request — collapsing ipScopedLimiter's per-client
// bucket (middleware/rateLimit.ts, routes.ts) into ONE shared bucket for
// all traffic through the proxy. See trustProxy.ts for the full grounding
// (deployment topology, the exact condition under which this process
// receives traffic, and why a client can't spoof this).
app.set("trust proxy", TRUSTED_PROXY_HOPS);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin / curl (no origin) and configured frontends.
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origen no permitido por CORS: ${origin}`));
    },
  })
);
app.use(express.json({ limit: "2mb" }));

app.use("/api", router);

app.get("/", (_req, res) => {
  res.json({ service: "SAS Pitch Simulator backend", status: "ok" });
});

initFirebase();

app.listen(config.port, () => {
  console.log(`[server] escuchando en http://localhost:${config.port}`);
  console.log(`[server] CORS permitido: ${config.corsOrigins.join(", ")}`);
});
