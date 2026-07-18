import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { router } from "./routes.js";
import { initFirebase } from "./firebase.js";

const app = express();

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
