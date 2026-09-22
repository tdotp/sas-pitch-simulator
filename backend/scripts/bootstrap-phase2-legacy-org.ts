// Reproducible, idempotent bootstrap for Phase 2 (Organization + Membership).
//
// Creates (or updates) ONE legacy/internal Organization and links the 4
// Firebase Auth users that already exist (created during Phase 1 — see
// PHASE_01_AUTH_IMPLEMENTATION_REPORT.md, MIGRATION_NOTES) to it as
// AGENCY_ADMIN.
//
// Safe to re-run: every write is an upsert against a deterministic
// document id (see repositories/organizations.ts, memberships.ts), so
// running this twice does not create duplicates. It does not store or
// print any secret — it only reads each user's uid from Firebase Auth by
// email (no passwords, no tokens are touched).
//
// Run with (from the repo root):
//   npx tsx backend/scripts/bootstrap-phase2-legacy-org.ts
// Needs backend/secrets/serviceAccount.json and backend/.env present,
// exactly like running the server locally.

import admin from "firebase-admin";
import { initFirebase, isAuthReady } from "../src/firebase.js";
import { upsertOrganization } from "../src/repositories/organizations.js";
import { upsertUser } from "../src/repositories/users.js";
import { upsertMembership } from "../src/repositories/memberships.js";

// Explicit, self-documenting name for the container these 4 pre-existing
// accounts land in until real client Organizations exist (Phase 2 doesn't
// build client onboarding yet — that's Phase 12/13). "legacy" flags it as
// a bootstrap artifact, not a real client.
const LEGACY_ORGANIZATION = {
  id: "smartpr-interno-legacy",
  name: "SmartPR — Interno (Legacy MVP)",
  slug: "smartpr-interno-legacy",
};

// All 4 are @smartpr.com.co — the agency's own team (not an external
// client), which is exactly what AGENCY_ADMIN represents. This is a
// bootstrap default: it grants access equivalent to what they already had
// under the Phase 1 allowlist, nothing more. Adjust per real org chart
// once CLIENT_ADMIN/COACH/SPOKESPERSON distinctions actually matter.
const LEGACY_USER_EMAILS = [
  "gerardo.calambas@smartpr.com.co",
  "daniel.espana@smartpr.com.co",
  "fabian.motta@smartpr.com.co",
  "juan.motta@smartpr.com.co",
];

async function main() {
  initFirebase();
  if (!isAuthReady()) {
    console.error(
      "[bootstrap] Firebase Admin no se pudo inicializar (revisa " +
        "FIREBASE_SERVICE_ACCOUNT_PATH en backend/.env). Abortando sin escribir nada."
    );
    process.exit(1);
  }

  const org = await upsertOrganization(LEGACY_ORGANIZATION);
  console.log(`[bootstrap] Organization lista: ${org.id} ("${org.name}")`);

  for (const email of LEGACY_USER_EMAILS) {
    let uid: string;
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      uid = userRecord.uid;
    } catch (err) {
      console.error(
        `[bootstrap] No existe en Firebase Auth, se omite: ${email} (${(err as Error).message})`
      );
      continue;
    }

    await upsertUser({ uid, email, display_name: null });
    const membership = await upsertMembership({
      userId: uid,
      organizationId: org.id,
      role: "AGENCY_ADMIN",
    });
    console.log(
      `[bootstrap] ${email} -> uid=${uid} -> Membership ${membership.id} ` +
        `(role=${membership.role}, status=${membership.status})`
    );
  }

  console.log("[bootstrap] Listo.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[bootstrap] Error:", err);
  process.exit(1);
});
