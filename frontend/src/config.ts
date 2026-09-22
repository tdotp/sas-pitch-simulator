// Frontend runtime config, all from Vite env (VITE_*).

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

// Sent as the x-app-token header on every API call — must match the
// backend's API_SHARED_TOKEN. Not a real secret (see backend/src/routes.ts).
export const API_TOKEN = import.meta.env.VITE_API_TOKEN ?? "";

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
