import { API_BASE, API_TOKEN } from "./config";
import { auth } from "./firebase";
import type {
  EndSessionResponse,
  StartSessionResponse,
  TargetMode,
  TranscriptTurn,
  VoiceGender,
} from "./types";

async function getAuthHeader(forceRefresh = false): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  const token = await user.getIdToken(forceRefresh);
  return { Authorization: `Bearer ${token}` };
}

async function doFetch(path: string, body: unknown, forceRefresh: boolean) {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_TOKEN ? { "x-app-token": API_TOKEN } : {}),
      ...(await getAuthHeader(forceRefresh)),
    },
    body: JSON.stringify(body),
  });
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res = await doFetch(path, body, false);

  // A 401 means the token was missing/invalid/expired — refresh it once
  // (force) and retry. A 403 means the token was valid but the account
  // isn't allowlisted: refreshing won't change that, so never retry on 403.
  if (res.status === 401) {
    res = await doFetch(path, body, true);
  }

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
