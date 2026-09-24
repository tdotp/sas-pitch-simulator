import dotenv from "dotenv";

dotenv.config();

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    // Don't throw at import time — some keys are only needed for certain
    // routes, and we want the server to boot even while creds are pending.
    return "";
  }
  return v;
}

// Fase 8 — USER_LIMITS/ORGANIZATION_LIMITS/GLOBAL_LIMITS. Falls back to
// `fallback` for an unset OR non-numeric env value rather than producing
// NaN (which would make every request either always-reject or
// never-reject, a silent footgun for a rate limit).
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: parseInt(process.env.PORT ?? "8080", 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  elevenlabs: {
    apiKey: req("ELEVENLABS_API_KEY"),
    agentId: req("ELEVENLABS_AGENT_ID"),
    voices: {
      male: req("ELEVEN_VOICE_MALE"),
      female: req("ELEVEN_VOICE_FEMALE"),
      genericA: req("ELEVEN_VOICE_GENERIC_A"),
      genericB: req("ELEVEN_VOICE_GENERIC_B"),
    },
  },

  openrouter: {
    apiKey: req("OPENROUTER_API_KEY"),
    model: req("OPENROUTER_MODEL", "anthropic/claude-sonnet-4"),
    siteUrl: req("OPENROUTER_SITE_URL", "http://localhost:5173"),
    appName: req("OPENROUTER_APP_NAME", "SAS Pitch Simulator"),
  },

  firebase: {
    serviceAccountPath: req("FIREBASE_SERVICE_ACCOUNT_PATH"),
    projectId: req("FIREBASE_PROJECT_ID"),
    storageBucket: req("FIREBASE_STORAGE_BUCKET"),
  },

  persistenceDisabled:
    (process.env.PERSISTENCE_DISABLED ?? "false").toLowerCase() === "true",

  // Shared token the frontend sends on every /api call. This is NOT a real
  // secret (it ships inside the public JS bundle) — it only raises the bar
  // above "anyone who finds the bare backend URL", combined with the
  // rate-limiter below. If unset, the check is skipped (local dev default).
  // It is anti-abuse only — never treat it as authentication.
  apiSharedToken: req("API_SHARED_TOKEN"),

  // Fase 8 — RATE_LIMIT_INVENTORY. Defaults are CONSERVATIVE ESTIMATES,
  // not load-tested numbers — see RATE_LIMIT_STORAGE_DECISION /
  // USER_LIMITS in PHASE_08_OBSERVABILITY_RATE_LIMITS_REPORT.md. All
  // overridable per-env without a code change. /session/start costs one
  // ElevenLabs signed-url call; /session/end costs one OpenRouter
  // evaluation (up to 2 attempts × 30s) — both real, external-provider
  // costs, unlike /metrics/analyze (local computation only, no external
  // call), which gets a lighter single per-user limit and no
  // organization/global tier.
  rateLimits: {
    sessionStart: {
      user: { windowMs: 60_000, limit: envInt("RATE_LIMIT_SESSION_START_USER_PER_MIN", 6) },
      organization: { windowMs: 60_000, limit: envInt("RATE_LIMIT_SESSION_START_ORG_PER_MIN", 30) },
      global: { windowMs: 60_000, limit: envInt("RATE_LIMIT_SESSION_START_GLOBAL_PER_MIN", 120) },
    },
    sessionEnd: {
      user: { windowMs: 60_000, limit: envInt("RATE_LIMIT_SESSION_END_USER_PER_MIN", 4) },
      organization: { windowMs: 60_000, limit: envInt("RATE_LIMIT_SESSION_END_ORG_PER_MIN", 20) },
      global: { windowMs: 60_000, limit: envInt("RATE_LIMIT_SESSION_END_GLOBAL_PER_MIN", 80) },
    },
    metricsAnalyze: {
      user: { windowMs: 60_000, limit: envInt("RATE_LIMIT_METRICS_ANALYZE_USER_PER_MIN", 30) },
    },
    // PASS_WITH_FIXES P1.1: pre-auth, IP-scoped safety cap — replaces the
    // old express-rate-limit-based 20/min-per-IP limiter, which sat
    // BEFORE every tenant-aware limit and was actually lower than
    // sessionStart.organization's 30/min, making it the real bottleneck
    // for a legitimate multi-user client behind a shared NAT instead of
    // the safety net it was meant to be. 300/min is deliberately well
    // above every per-endpoint organization limit above (30 for
    // /session/start, 20 for /session/end) so a real shared-NAT tenant
    // with several concurrent users never hits this before their own
    // organization limit would kick in — it exists to stop a genuine
    // flood, not to police normal shared-office traffic. Still a
    // conservative estimate, not load-tested.
    ipSafetyCap: { windowMs: 60_000, limit: envInt("RATE_LIMIT_IP_SAFETY_CAP_PER_MIN", 300) },
  },

  // AUTH_ALLOWED_EMAILS (the Phase 1 temporary allowlist) was retired in
  // Phase 3: every sensitive route now requires requireMembership, which
  // rejects any Firebase user without a real AppUser+Membership record —
  // the same protection the allowlist gave, without a second parallel
  // system. See ALLOWLIST_DECISION in
  // PHASE_03_TENANT_ISOLATION_RBAC_REPORT.md. If AUTH_ALLOWED_EMAILS is
  // still set in the environment, it is now simply unused.
} as const;

export function assertElevenReady(): string | null {
  if (!config.elevenlabs.apiKey) return "ELEVENLABS_API_KEY no configurada";
  if (!config.elevenlabs.agentId) return "ELEVENLABS_AGENT_ID no configurada";
  return null;
}

export function assertOpenRouterReady(): string | null {
  if (!config.openrouter.apiKey) return "OPENROUTER_API_KEY no configurada";
  return null;
}
