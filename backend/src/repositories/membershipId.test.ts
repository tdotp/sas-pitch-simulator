// Protects membershipId() against the ambiguous-composition bug flagged in
// the Phase 2 PASS_WITH_FIXES review: two distinct (userId, organizationId)
// pairs must never produce the same id, even when either component
// contains the "::" separator itself.
import { describe, it, expect } from "vitest";
import { membershipId } from "./memberships.js";

describe("membershipId", () => {
  it("does not collide when the separator appears inside a component", () => {
    // Before the fix, both of these concatenated to the literal string
    // "a::b::c" — two different pairs, one id.
    const idA = membershipId("a::b", "c");
    const idB = membershipId("a", "b::c");

    expect(idA).not.toBe(idB);
  });

  it("does not collide across several adversarial pairs with embedded separators", () => {
    const pairs: Array<[string, string]> = [
      ["a::b", "c"],
      ["a", "b::c"],
      ["a::b::c", ""],
      ["", "a::b::c"],
      ["a:b", ":c"],
      ["a", "b"],
    ];

    const ids = pairs.map(([u, o]) => membershipId(u, o));
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(pairs.length);
  });

  it("is deterministic: the same pair always produces the same id", () => {
    expect(membershipId("uid-1", "org-1")).toBe(membershipId("uid-1", "org-1"));
  });

  it("is backward compatible with ids already written to Firestore", () => {
    // Real ids from the Phase 2 bootstrap (alphanumeric Firebase uid +
    // hyphenated slug organization id) — neither component contains any
    // character encodeURIComponent escapes, so the encoded id is
    // byte-for-byte identical to the pre-fix unencoded one. No Firestore
    // migration was needed for existing documents.
    const uid = "1v48Faxn6CdtRgIq2QZ5FYI7YGL2";
    const orgId = "smartpr-interno-legacy";

    expect(membershipId(uid, orgId)).toBe(`${uid}::${orgId}`);
  });

  it("does not produce a '/' (the one character Firestore document ids cannot contain)", () => {
    const id = membershipId("weird/uid", "weird/org");
    expect(id).not.toContain("/");
  });
});
