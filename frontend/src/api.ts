import { API_BASE, API_TOKEN } from "./config";
import type {
  EndSessionResponse,
  StartSessionResponse,
  TargetMode,
  TranscriptTurn,
  VoiceGender,
} from "./types";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_TOKEN ? { "x-app-token": API_TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function startSession(params: {
  target_mode: TargetMode;
  voice_gender?: VoiceGender;
  user_id?: string;
  user_name?: string;
}): Promise<StartSessionResponse> {
  return post<StartSessionResponse>("/session/start", params);
}

export function endSession(params: {
  session_id: string;
  target_mode: TargetMode;
  transcript: TranscriptTurn[];
  duration_seconds: number;
}): Promise<EndSessionResponse> {
  return post<EndSessionResponse>("/session/end", params);
}

export async function health(): Promise<{
  ok: boolean;
  eleven_ready: boolean;
  openrouter_ready: boolean;
}> {
  const res = await fetch(`${API_BASE}/health`);
  return (await res.json()) as {
    ok: boolean;
    eleven_ready: boolean;
    openrouter_ready: boolean;
  };
}
