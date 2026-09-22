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
