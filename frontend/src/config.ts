// Frontend runtime config, all from Vite env (VITE_*).

export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export const APP_USER = import.meta.env.VITE_APP_USER ?? "sandra";
export const APP_PASSWORD = import.meta.env.VITE_APP_PASSWORD ?? "sas2026";

export const TIMER = {
  idealSeconds: 90,
  maxSeconds: 180,
  warnSeconds: 60, // gentle "approaching ideal" cue
};

export const TARGETS = [
  {
    id: "generic",
    label: "Genérico",
    subtitle: "C-level estándar, sin empresa específica",
    accent: "#0072C6",
    allowsVoiceChoice: true,
  },
  {
    id: "davivienda",
    label: "Davivienda",
    subtitle: "Perfil CEO banca multilatina · voz masculina",
    accent: "#E4002B",
    allowsVoiceChoice: false,
  },
  {
    id: "grupo_aval",
    label: "Grupo Aval",
    subtitle: "Perfil presidenta de holding financiero · voz femenina",
    accent: "#003DA5",
    allowsVoiceChoice: false,
  },
] as const;

export type TargetId = (typeof TARGETS)[number]["id"];
