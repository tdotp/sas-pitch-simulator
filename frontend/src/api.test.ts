// Tests the critical auth behavior of the API client:
//  - every call attaches the Firebase ID token as `Authorization: Bearer`;
//  - a 401 (missing/expired token) triggers exactly one retry with a
//    force-refreshed token;
//  - a 403 (valid token, not allowlisted) must NEVER trigger a refresh or
//    retry — refreshing the token cannot fix "you're not allowed".
import { describe, it, expect, vi, beforeEach } from "vitest";

const getIdTokenMock = vi.fn();
let currentUser: { getIdToken: typeof getIdTokenMock } | null = null;

vi.mock("./firebase", () => ({
  auth: {
    get currentUser() {
      return currentUser;
    },
  },
}));

vi.mock("./config", () => ({
  API_BASE: "/api",
  API_TOKEN: "",
}));

const { startSession } = await import("./api");

beforeEach(() => {
  getIdTokenMock.mockReset();
  currentUser = { getIdToken: getIdTokenMock };
  vi.stubGlobal("fetch", vi.fn());
});

describe("api.ts auth handling", () => {
  it("attaches the current ID token as a Bearer header", async () => {
    getIdTokenMock.mockResolvedValue("token-1");
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session_id: "s1" }),
    });

    await startSession({ target_mode: "generic" });

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer token-1");
  });

  it("retries exactly once with a force-refreshed token after a 401", async () => {
    getIdTokenMock.mockResolvedValueOnce("stale-token").mockResolvedValueOnce("fresh-token");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: "No autorizado" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ session_id: "s1" }) });

    const result = await startSession({ target_mode: "generic" });

    expect(result).toEqual({ session_id: "s1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getIdTokenMock).toHaveBeenNthCalledWith(1, false);
    expect(getIdTokenMock).toHaveBeenNthCalledWith(2, true);
    const secondCallHeaders = fetchMock.mock.calls[1][1].headers;
    expect(secondCallHeaders.Authorization).toBe("Bearer fresh-token");
  });

  it("does not retry a second time if the refreshed token still gets a 401", async () => {
    getIdTokenMock.mockResolvedValue("token");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "No autorizado" }) });

    await expect(startSession({ target_mode: "generic" })).rejects.toThrow("No autorizado");
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + exactly one retry
  });

  it("never retries on a 403 (valid token, not allowlisted)", async () => {
    getIdTokenMock.mockResolvedValue("token");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "No tienes acceso a esta aplicación" }),
    });

    await expect(startSession({ target_mode: "generic" })).rejects.toThrow(
      "No tienes acceso a esta aplicación"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getIdTokenMock).toHaveBeenCalledTimes(1); // no forced refresh attempted
  });
});
