// Server-side resolution of "who is this Firebase user, in which
// Organization, with which Role" — Phase 2's domain model applied to a
// single authenticated request. Nothing here trusts anything the client
// sends: organizationId and role always come from a Membership document
// read from Firestore, keyed by the ALREADY-VERIFIED uid (requireAuth runs
// before this).
import type { AppContext, Membership, Role } from "../types.js";
import { listMembershipsByUser as listMembershipsByUserFirestore } from "../repositories/memberships.js";

// Injectable, mirrors middleware/auth.ts's IdTokenVerifier pattern — lets
// tests exercise the resolution logic without touching real Firestore.
export type MembershipLister = (userId: string) => Promise<Membership[]>;

// MULTI_MEMBERSHIP_SELECTION_STRATEGY (Phase 2, temporary — see
// AGENCY_ADMIN_MODEL in PHASE_02_ORG_MEMBERSHIP_IMPLEMENTATION_REPORT.md).
//
// A user CAN have more than one active Membership — that's the whole point
// of putting the user<->organization link on Membership instead of a fixed
// field on User, so an AGENCY_ADMIN can eventually belong to several
// organizations. This phase does not yet build a way for the frontend to
// pick which one is "active" (no UI, no endpoint for it — letting the
// client choose is explicitly a Phase 3+ concern, and it would still have
// to be verified against the user's real memberships, never trusted
// blindly). Until then, resolveAppContext deterministically picks the
// OLDEST active Membership (earliest created_at) as "the" context for
// single-context callers like GET /me. This is arbitrary but stable and
// tested (see context.test.ts) — it does NOT mean Membership collapses
// back into "one organization per user forever": a user with N
// memberships still has N Membership documents in Firestore.
function pickActiveMembership(memberships: Membership[]): Membership | null {
  const active = memberships.filter((m) => m.status === "active");
  if (active.length === 0) return null;
  return [...active].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
}

export async function resolveAppContext(
  userId: string,
  email: string | null,
  listMembershipsByUser: MembershipLister = listMembershipsByUserFirestore
): Promise<AppContext | null> {
  const memberships = await listMembershipsByUser(userId);
  const membership = pickActiveMembership(memberships);
  if (!membership) return null;

  return {
    userId,
    email,
    organizationId: membership.organization_id,
    role: membership.role as Role,
  };
}
