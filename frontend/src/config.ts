// Frontend runtime config, all from Vite env (VITE_*).

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// Sent as the x-app-token header on every API call — must match the
// backend's API_SHARED_TOKEN. Not a real secret (see backend/src/routes.ts).
export const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? "";

// MVP access gate — a frontend-only check, not real authentication.
// These credentials are visible in the built JS bundle to anyone who opens
// devtools; this is acceptable for an internal single-team tool but should
// not be treated as a security boundary.
export const APP_USERS: Array<{ user: string; password: string }> = [
  { user: "gerardo.calambas@smartpr.com.co", password: "memobox1810" },
  { user: "daniel.espana@smartpr.com.co", password: "123456" },
  { user: "fabian.motta@smartpr.com.co", password: "123456" },
  { user: "juan.motta@smartpr.com.co", password: "123456" },
];

export const TIMER = {
  idealSeconds: 90,
  maxSeconds: 180,
  warnSeconds: 60, // gentle "approaching ideal" cue
};

export const TARGETS = [
  {
    id: "generic",
    number: "01",
    label: "Conversación general",
    subtitle: "Practica una presentación ejecutiva sin una compañía específica.",
    accent: "#0072C6",
    allowsVoiceChoice: true,
  },
  {
    id: "davivienda",
    number: "02",
    label: "Davivienda",
    subtitle: "Enfoque en transformación, riesgo, cliente e innovación.",
    accent: "#E4002B",
    allowsVoiceChoice: false,
  },
  {
    id: "grupo_aval",
    number: "03",
    label: "Grupo Aval",
    subtitle: "Enfoque en escala, eficiencia, rentabilidad e integración.",
    accent: "#003DA5",
    allowsVoiceChoice: false,
  },
] as const;

export type TargetId = (typeof TARGETS)[number]["id"];
