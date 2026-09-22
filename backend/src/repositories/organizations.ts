// Firestore-backed Organization repository. Deliberately minimal:
// create/read/upsert only — no client configuration lives here (Phase 5).
import admin from "firebase-admin";
import type { EntityStatus, Organization } from "../types.js";

const COLLECTION = "organizations";

// Runtime validation for data read back from Firestore: Firestore has no
// schema, so a malformed/partial document (manual edit, future migration
// bug) must not crash the caller. We log and treat it as absent instead of
// trusting the shape.
function parseOrganization(
  id: string,
  data: FirebaseFirestore.DocumentData | undefined
): Organization | null {
  if (!data) return null;
  const { name, slug, status, created_at, updated_at } = data;
  if (
    typeof name !== "string" ||
    typeof slug !== "string" ||
    (status !== "active" && status !== "inactive") ||
    typeof created_at !== "string" ||
    typeof updated_at !== "string"
  ) {
    console.error(`[organizations] Documento con forma inválida, se ignora: ${id}`);
    return null;
  }
  return { id, name, slug, status: status as EntityStatus, created_at, updated_at };
}

export async function getOrganization(id: string): Promise<Organization | null> {
  const snap = await admin.firestore().collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return parseOrganization(snap.id, snap.data());
}

// Upsert by id (idempotent — safe for the bootstrap script to re-run).
// Preserves the original created_at across re-runs.
export async function upsertOrganization(params: {
  id: string;
  name: string;
  slug: string;
  status?: EntityStatus;
}): Promise<Organization> {
  const ref = admin.firestore().collection(COLLECTION).doc(params.id);
  const existing = await ref.get();
  const now = new Date().toISOString();
  const created_at =
    (existing.exists ? (existing.data()?.created_at as string | undefined) : undefined) ?? now;

  const doc = {
    name: params.name,
    slug: params.slug,
    status: params.status ?? "active",
    created_at,
    updated_at: now,
  };
  await ref.set(doc, { merge: true });
  return { id: params.id, ...doc };
}
