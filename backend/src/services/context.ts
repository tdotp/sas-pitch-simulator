// Server-side resolution of "who is this Firebase user, in which
// Organization, with which Role" — Phase 2's domain model applied to a
// single authenticated request. Nothing here trusts anything the client
// sends as authority: organizationId and role always come from a
// Membership document read from Firestore, keyed by the ALREADY-VERIFIED
// uid (requireAuth runs before this). A client MAY request a specific
// organizationId (see requestedOrganizationId) — that is a SELECTION among
// the caller's own real memberships, verified server-side below, never an
// authority. Requesting an organization the caller doesn't belong to is
// rejected, not honored.
import type { AppContext, AppUser, Membership, Organization, Role } from "../types.js";
import { listMembershipsByUser as listMembershipsByUserFirestore } from "../repositories/memberships.js";
import { getUser as getUserFirestore } from "../repositories/users.js";
import { getOrganization as getOrganizationFirestore } from "../repositories/organizations.js";

// AUTHORIZATION_SEMANTICS (Phase 2, PASS_WITH_FIXES round): a context is
// only valid when ALL THREE are active — the AppUser, the Membership, and
// the Organization it points to. An active Membership in a deactivated
// Organization (or belonging to a deactivated AppUser) grants nothing.
// This was previously an open KNOWN_LIMITATION ("Organization.status is
// not checked"); it is now enforced, not just documented.
export type MembershipLister = (userId: string) => Promise<Membership[]>;
export type UserGetter = (uid: string) => Promise<AppUser | null>;
export type OrganizationGetter = (id: string) => Promise<Organization | null>;

export interface ContextResolutionDeps {
  listMembershipsByUser: MembershipLister;
  getUser: UserGetter;
  getOrganization: OrganizationGetter;
}

// Injectable, mirrors middleware/auth.ts's IdTokenVerifier pattern — lets
// tests exercise the resolution logic without touching real Firestore.
const defaultDeps: ContextResolutionDeps = {
  listMembershipsByUser: listMembershipsByUserFirestore,
  getUser: getUserFirestore,
  getOrganization: getOrganizationFirestore,
};

// MULTI_MEMBERSHIP_SELECTION (Phase 2, PASS_WITH_FIXES round — replaces
// the earlier "oldest active Membership wins" strategy, which the review
// correctly flagged as an arbitrary pick among ambiguous options).
//
// A user CAN have more than one eligible Membership — that's the whole
// point of putting the user<->organization link on Membership instead of
// a fixed field on User, so an AGENCY_ADMIN can eventually belong to
// several organizations. resolveAppContext never guesses which one the
// caller means:
//   0 eligible  -> "no_membership" (reject)
//   1 eligible  -> that one, automatically
//   2+ eligible, no requestedOrganizationId -> "selection_required"
//   2+ eligible, requestedOrganizationId given and it's one of them
//               -> "ok" for that one
//   requestedOrganizationId given and it's NOT one of the caller's
//   eligible memberships -> "forbidden_organization" (never silently
//   falls back to a different one, and never trusts the id as authority —
//   it's checked against the caller's own real, verified memberships).
// No org switcher UI exists yet to drive requestedOrganizationId from the
// frontend — that's still Phase 3+. This only guarantees the backend
// never picks arbitrarily in the meantime.
export type ContextResolution =
  | { type: "ok"; context: AppContext }
  | { type: "no_membership" }
  | { type: "selection_required"; organizationIds: string[] }
  | { type: "forbidden_organization" };

function toContext(userId: string, email: string | null, membership: Membership): AppContext {
  return {
    userId,
    email,
    organizationId: membership.organization_id,
    role: membership.role as Role,
  };
}

export async function resolveAppContext(
  userId: string,
  email: string | null,
  requestedOrganizationId: string | null = null,
  deps: ContextResolutionDeps = defaultDeps
): Promise<ContextResolution> {
  const user = await deps.getUser(userId);
  if (!user || user.status !== "active") {
    // No AppUser record, or an explicitly deactivated one: same
    // rejection as "no membership" — there is nothing valid to grant
    // either way, and this keeps the middleware's response shape simple.
    return { type: "no_membership" };
  }

  const memberships = await deps.listMembershipsByUser(userId);
  const activeMemberships = memberships.filter((m) => m.status === "active");

  // An active Membership only counts if its Organization is ALSO active.
  const eligible: Membership[] = [];
  for (const membership of activeMemberships) {
    const org = await deps.getOrganization(membership.organization_id);
    if (org && org.status === "active") {
      eligible.push(membership);
    }
  }

  if (eligible.length === 0) {
    return { type: "no_membership" };
  }

  if (requestedOrganizationId) {
    const match = eligible.find((m) => m.organization_id === requestedOrganizationId);
    if (!match) {
      return { type: "forbidden_organization" };
    }
    return { type: "ok", context: toContext(userId, email, match) };
  }

  if (eligible.length === 1) {
    return { type: "ok", context: toContext(userId, email, eligible[0]) };
  }

  return {
    type: "selection_required",
    organizationIds: eligible.map((m) => m.organization_id),
  };
}
