// Firestore-backed AppUser repository. NEVER stores a password or any auth
// secret — Firebase Auth remains the sole authentication authority. This
// is application metadata about a Firebase user (display name, status).
import admin from "firebase-admin";
import type { AppUser, EntityStatus } from "../types.js";

const COLLECTION = "users";

function parseUser(uid: string, data: FirebaseFirestore.DocumentData | undefined): AppUser | null {
  if (!data) return null;
  const { email, display_name, status, created_at, updated_at } = data;
  if (
    (email !== null && typeof email !== "string") ||
    (display_name !== null && typeof display_name !== "string") ||
    (status !== "active" && status !== "inactive") ||
    typeof created_at !== "string" ||
    typeof updated_at !== "string"
  ) {
    console.error(`[users] Documento con forma inválida, se ignora: ${uid}`);
    return null;
  }
  return {
    uid,
    email: (email as string | null | undefined) ?? null,
    display_name: (display_name as string | null | undefined) ?? null,
    status: status as EntityStatus,
    created_at,
    updated_at,
  };
}

export async function getUser(uid: string): Promise<AppUser | null> {
  const snap = await admin.firestore().collection(COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  return parseUser(snap.id, snap.data());
}

// Upsert by uid (idempotent). Preserves created_at across re-runs.
export async function upsertUser(params: {
  uid: string;
  email: string | null;
  display_name?: string | null;
  status?: EntityStatus;
}): Promise<AppUser> {
  const ref = admin.firestore().collection(COLLECTION).doc(params.uid);
  const existing = await ref.get();
  const now = new Date().toISOString();
  const created_at =
    (existing.exists ? (existing.data()?.created_at as string | undefined) : undefined) ?? now;

  const doc = {
    email: params.email,
    display_name: params.display_name ?? null,
    status: params.status ?? "active",
    created_at,
    updated_at: now,
  };
  await ref.set(doc, { merge: true });
  return { uid: params.uid, ...doc };
}
