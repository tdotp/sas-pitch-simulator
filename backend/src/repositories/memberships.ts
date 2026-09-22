// Firestore-backed Membership repository.
//
// FIRESTORE SCHEMA DECISION (see PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md
// for the full writeup): a flat root collection `memberships/{membershipId}`
// where the document id is deterministically derived from (user_id,
// organization_id) via membershipId() below. This gives us, without any
// composite index configuration:
//   - "membership por usuario+organización" -> a direct doc get() by id —
//     O(1), no query at all;
//   - "memberships por usuario"             -> where('user_id','==',uid),
//     a single-field equality query, auto-indexed by Firestore;
//   - "memberships por organización"        -> where('organization_id','==',orgId),
//     same as above.
// The deterministic id also enforces "la combinación usuario + organización
// debe ser inequívoca" by construction: writing a membership for a pair
// always targets the same document, so it is structurally impossible to
// end up with two membership documents for the same (user, org) pair —
// there is nothing to "check" at write time.
import admin from "firebase-admin";
import type { EntityStatus, Membership, Role } from "../types.js";

const COLLECTION = "memberships";
const VALID_ROLES: Role[] = ["AGENCY_ADMIN", "CLIENT_ADMIN", "COACH", "SPOKESPERSON"];

// "::" cannot appear in a Firebase uid (alphanumeric) or in the slug-style
// organization ids this project generates, so it's a safe, readable
// separator for the deterministic id.
export function membershipId(userId: string, organizationId: string): string {
  return `${userId}::${organizationId}`;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as string[]).includes(value);
}

function parseMembership(
  id: string,
  data: FirebaseFirestore.DocumentData | undefined
): Membership | null {
  if (!data) return null;
  const { user_id, organization_id, role, status, created_at, updated_at } = data;
  if (
    typeof user_id !== "string" ||
    typeof organization_id !== "string" ||
    !isRole(role) ||
    (status !== "active" && status !== "inactive") ||
    typeof created_at !== "string" ||
    typeof updated_at !== "string"
  ) {
    console.error(`[memberships] Documento con forma inválida, se ignora: ${id}`);
    return null;
  }
  return {
    id,
    user_id,
    organization_id,
    role,
    status: status as EntityStatus,
    created_at,
    updated_at,
  };
}

export async function getMembership(
  userId: string,
  organizationId: string
): Promise<Membership | null> {
  const id = membershipId(userId, organizationId);
  const snap = await admin.firestore().collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return parseMembership(snap.id, snap.data());
}

export async function listMembershipsByUser(userId: string): Promise<Membership[]> {
  const snap = await admin
    .firestore()
    .collection(COLLECTION)
    .where("user_id", "==", userId)
    .get();
  return snap.docs
    .map((d) => parseMembership(d.id, d.data()))
    .filter((m): m is Membership => m !== null);
}

export async function listMembershipsByOrganization(organizationId: string): Promise<Membership[]> {
  const snap = await admin
    .firestore()
    .collection(COLLECTION)
    .where("organization_id", "==", organizationId)
    .get();
  return snap.docs
    .map((d) => parseMembership(d.id, d.data()))
    .filter((m): m is Membership => m !== null);
}

// Upsert (idempotent — safe for the bootstrap script to re-run, and the
// natural way to change someone's role or reactivate them: write a new
// membership for the same pair, it overwrites the same document).
export async function upsertMembership(params: {
  userId: string;
  organizationId: string;
  role: Role;
  status?: EntityStatus;
}): Promise<Membership> {
  const id = membershipId(params.userId, params.organizationId);
  const ref = admin.firestore().collection(COLLECTION).doc(id);
  const existing = await ref.get();
  const now = new Date().toISOString();
  const created_at =
    (existing.exists ? (existing.data()?.created_at as string | undefined) : undefined) ?? now;

  const doc = {
    user_id: params.userId,
    organization_id: params.organizationId,
    role: params.role,
    status: params.status ?? "active",
    created_at,
    updated_at: now,
  };
  await ref.set(doc, { merge: true });
  return { id, ...doc };
}
