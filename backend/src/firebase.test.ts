// Protects the separation between Firebase Admin (Auth) and
// PERSISTENCE_DISABLED (Firestore only). Firebase Admin — and therefore
// admin.auth().verifyIdToken(), which requireAuth depends on — must
// initialize whenever valid credentials are configured, regardless of
// whether Firestore persistence is enabled.
import { describe, it, expect, vi, beforeEach } from "vitest";

const initializeAppMock = vi.fn();
const firestoreMock = vi.fn(() => ({}));

vi.mock("firebase-admin", () => ({
  default: {
    initializeApp: initializeAppMock,
    firestore: firestoreMock,
    credential: { cert: (sa: unknown) => sa },
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() =>
    JSON.stringify({
      project_id: "test-project",
      private_key: "fake-key",
      client_email: "fake@test-project.iam.gserviceaccount.com",
    })
  ),
}));

// Mutable, shared-by-reference config mock so each test can flip
// persistenceDisabled / serviceAccountPath and have firebase.ts see it.
const configMock = {
  persistenceDisabled: false,
  firebase: {
    serviceAccountPath: "./fake-service-account.json",
    projectId: "test-project",
    storageBucket: "",
  },
};

vi.mock("./config.js", () => ({ config: configMock }));

// firebase.ts keeps its Auth/Firestore readiness as module-level state that
// only ever moves forward within a process. Each test needs a fresh module
// instance (vi.resetModules) so one scenario's state can't leak into the
// next — initFirebase() intentionally doesn't reset flags on an early
// return, matching real startup behavior where it only runs once.
async function freshFirebaseModule() {
  vi.resetModules();
  return import("./firebase.js");
}

beforeEach(() => {
  initializeAppMock.mockClear();
  firestoreMock.mockClear();
  configMock.persistenceDisabled = false;
  configMock.firebase.serviceAccountPath = "./fake-service-account.json";
});

describe("Firebase Admin init is decoupled from PERSISTENCE_DISABLED", () => {
  it("initializes Firebase Admin (Auth) even when persistence is disabled", async () => {
    configMock.persistenceDisabled = true;
    const { initFirebase, isAuthReady, isPersistenceEnabled } = await freshFirebaseModule();

    initFirebase();

    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(isAuthReady()).toBe(true);
    // Firestore must NOT be touched — PERSISTENCE_DISABLED only gates this.
    expect(firestoreMock).not.toHaveBeenCalled();
    expect(isPersistenceEnabled()).toBe(false);
  });

  it("also enables Firestore persistence when PERSISTENCE_DISABLED is false", async () => {
    configMock.persistenceDisabled = false;
    const { initFirebase, isAuthReady, isPersistenceEnabled } = await freshFirebaseModule();

    initFirebase();

    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(isAuthReady()).toBe(true);
    expect(firestoreMock).toHaveBeenCalledTimes(1);
    expect(isPersistenceEnabled()).toBe(true);
  });

  it("leaves both Auth and persistence off without a service account path", async () => {
    configMock.firebase.serviceAccountPath = "";
    const { initFirebase, isAuthReady, isPersistenceEnabled } = await freshFirebaseModule();

    initFirebase();

    expect(initializeAppMock).not.toHaveBeenCalled();
    expect(isAuthReady()).toBe(false);
    expect(isPersistenceEnabled()).toBe(false);
  });
});
