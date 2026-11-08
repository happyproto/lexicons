/**
 * admin.createSpaces, and how the gates find both spaces, on a real
 * HappyView v3.
 *
 * HappyView gives each space a DID of its own. setup.ts bootstraps the
 * stack's spaces by calling createSpaces as `happyproto` and setting
 * HAPPYPROTO_ADMIN_SPACE and HAPPYPROTO_CUSTOMERS_SPACE to the uris it
 * answers, so every other file runs against configured uris. This file checks
 * what that bootstrap made, who else may call it, and -- with HAPPYPROTO_DID
 * pointed at `outsider` and the space variables cleared for one test -- a
 * genuine first call and its repeat, on spaces that test removes again.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessionHeaders } from "./session";
import { HAPPYVIEW_URL, setVariable, stack, type Account, type Stack } from "./setup";
import { call, fails, ok } from "./xrpc";

const nsid = "at.happyproto.admin.createSpaces";
const MEMBERSPACE = { $type: "com.atproto.memberspace.policy", publicRead: false, publicWrite: false };
const SPACE_TYPES = ["at.happyproto.admin", "at.happyproto.customers"];

let s: Stack;

/** `at://<did:plc>/space/<type>/main`. */
const spaceOfType = (type: string) => new RegExp(`^at://did:plc:[a-z2-7]+/space/${type.replaceAll(".", "\\.")}/main$`);

function headers(who: Account): Record<string, string> {
  return {
    ...sessionHeaders(who.did),
    "x-client-key": s.client.key,
    "x-client-secret": s.client.secret,
    "content-type": "application/json",
  };
}

/** The space as its creator reads it through space.getSpace, or null. */
async function getSpace(who: Account, uri: string): Promise<any | null> {
  const url = new URL("/xrpc/com.atproto.space.getSpace", HAPPYVIEW_URL);
  url.searchParams.set("space", uri);
  const res = await fetch(url, { headers: headers(who) });
  return res.ok ? res.json() : null;
}

/** The uris of the spaces of `type` that `who` belongs to. */
async function spacesOf(who: Account, type: string): Promise<string[]> {
  const url = new URL("/xrpc/com.atproto.space.listSpaces", HAPPYVIEW_URL);
  url.searchParams.set("spaceType", type);
  const res = await fetch(url, { headers: headers(who) });
  if (!res.ok) throw new Error(`listSpaces answered ${res.status}`);
  return ((await res.json()).spaces as { uri: string }[]).map((space) => space.uri);
}

/** Delete every HappyProto space `who` belongs to, as its creator. */
async function deleteOwnSpaces(who: Account): Promise<void> {
  for (const type of SPACE_TYPES) {
    for (const uri of await spacesOf(who, type)) {
      await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.space.deleteSpace`, {
        method: "POST",
        headers: headers(who),
        body: JSON.stringify({ space: uri }),
      });
    }
  }
}

/** Run `body` with these script variables, restoring setup's afterwards. */
async function withVariables<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
  try {
    for (const [key, value] of Object.entries(values)) await setVariable(s.apiKey, key, value);
    return await body();
  } finally {
    for (const key of Object.keys(values)) await setVariable(s.apiKey, key, s.variables[key]);
  }
}

beforeAll(async () => {
  s = await stack();
}, 180_000);

afterAll(async () => {
  // The first-call test's spaces, should it have failed before removing them.
  await deleteOwnSpaces(s.accounts.outsider);
}, 30_000);

describe("the bootstrapped spaces", () => {
  test("are each on a DID of its own, named by its variable", () => {
    expect(s.spaces.admin).toMatch(spaceOfType("at.happyproto.admin"));
    expect(s.spaces.customers).toMatch(spaceOfType("at.happyproto.customers"));
    expect(s.spaces.admin).not.toContain(s.accounts.happyproto.did);
    expect([s.variables.HAPPYPROTO_ADMIN_SPACE, s.variables.HAPPYPROTO_CUSTOMERS_SPACE]).toEqual([
      s.spaces.admin,
      s.spaces.customers,
    ]);
  });

  test("are member-only to read and to write", async () => {
    for (const uri of [s.spaces.admin, s.spaces.customers]) {
      expect(await getSpace(s.accounts.happyproto, uri)).toMatchObject({ uri, policy: MEMBERSPACE });
    }
  });

  test("a second call creates nothing and adds no one", async () => {
    const out = await ok(nsid, "happyproto", { input: { staff: [s.accounts.staff.did] } });
    expect(out).toEqual({
      adminSpace: { uri: s.spaces.admin, created: false },
      customersSpace: { uri: s.spaces.customers, created: false },
      staffAdded: [],
    });
  });

  test("with no staff, a call is still a no-op", async () => {
    const out = await ok(nsid, "happyproto", { input: {} });
    expect(out.staffAdded).toEqual([]);
    expect([out.adminSpace.created, out.customersSpace.created]).toEqual([false, false]);
  });
});

describe("refusals", () => {
  test("anyone but HAPPYPROTO_DID is Forbidden, and nothing is created", async () => {
    for (const who of ["staff", "customer", "outsider"] as const) {
      await fails(nsid, who, "Forbidden", { input: { staff: [s.accounts.outsider.did] } });
    }
    // `staff` belongs to the real admin space; the others to no admin space.
    for (const who of ["customer", "outsider"] as const) {
      expect(await spacesOf(s.accounts[who], "at.happyproto.admin")).toEqual([]);
    }
    // And the staff it named were not added.
    const profile = await ok("at.happyproto.actor.getProfile", "outsider");
    expect(profile.isMember).toBe(false);
  });

  test("a signed-out caller is refused, and nothing is created", async () => {
    // HappyView refuses an anonymous procedure itself, before the script
    // runs; gate_owner's Forbidden for no caller is the unit tests' to show.
    const anonymous = await call(nsid, null, { input: { staff: [s.accounts.outsider.did] } });
    expect(anonymous.status).toBe(401);
    expect((await ok("at.happyproto.actor.getProfile", "outsider")).isMember).toBe(false);
  });

  test("an unset or malformed HAPPYPROTO_DID is Forbidden to createSpaces", async () => {
    for (const value of ["", "happyproto", `${s.accounts.happyproto.did}/space/x`]) {
      await withVariables({ HAPPYPROTO_DID: value }, async () => {
        await fails(nsid, "happyproto", "Forbidden", { input: {} });
      });
    }
  });

  test("with neither a space variable nor HAPPYPROTO_DID, every gate refuses", async () => {
    await withVariables(
      { HAPPYPROTO_DID: "", HAPPYPROTO_ADMIN_SPACE: "", HAPPYPROTO_CUSTOMERS_SPACE: "" },
      async () => {
        await fails("at.happyproto.admin.listCustomers", "staff", "Forbidden");
        await fails("at.happyproto.admin.listCustomers", "happyproto", "Forbidden");
        await fails("at.happyproto.server.listPlans", "customer", "Forbidden");
      },
    );
  });

  test("a space variable that addresses no space of its type refuses its gate", async () => {
    await withVariables({ HAPPYPROTO_ADMIN_SPACE: s.spaces.customers }, async () => {
      await fails("at.happyproto.admin.listCustomers", "staff", "Forbidden");
    });
  });

  test("staff that is not a list of at most 50 DIDs is InvalidRequest, and changes nothing", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `did:plc:staff${i}`);
    for (const staff of [["alice"], [s.accounts.outsider.did, ""], many, "did:plc:x", { a: "did:plc:x" }]) {
      await fails(nsid, "happyproto", "InvalidRequest", { input: { staff } });
    }
    expect((await ok("at.happyproto.actor.getProfile", "outsider")).isMember).toBe(false);
  });
});

describe("a first call", () => {
  test("creates both spaces, member-only, and adds staff once; a repeat is a no-op", async () => {
    const owner = s.accounts.outsider;
    // A rerun against a stack where this test failed half-way starts clean.
    await deleteOwnSpaces(owner);

    const unset = { HAPPYPROTO_ADMIN_SPACE: "", HAPPYPROTO_CUSTOMERS_SPACE: "" };
    await withVariables({ HAPPYPROTO_DID: owner.did, ...unset }, async () => {
      // `customer` twice, and the owner, who is already a member as creator.
      const staff = [s.accounts.customer.did, s.accounts.customer.did, owner.did];
      const first = await ok(nsid, "outsider", { input: { staff } });
      expect(first.adminSpace.uri).toMatch(spaceOfType("at.happyproto.admin"));
      expect(first.customersSpace.uri).toMatch(spaceOfType("at.happyproto.customers"));
      expect([first.adminSpace.created, first.customersSpace.created]).toEqual([true, true]);
      expect(first.staffAdded).toEqual([s.accounts.customer.did]);
      const own = { admin: first.adminSpace.uri as string, customers: first.customersSpace.uri as string };

      for (const uri of [own.admin, own.customers]) {
        expect(await getSpace(owner, uri)).toMatchObject({ uri, policy: MEMBERSPACE });
      }

      // Until a variable names it, a space on its own DID cannot be found,
      // and a repeat says which variable to set.
      const lost = await fails(nsid, "outsider", "Conflict", { input: { staff } });
      expect(lost.body.message).toContain("HAPPYPROTO_ADMIN_SPACE");

      await withVariables({ HAPPYPROTO_ADMIN_SPACE: own.admin, HAPPYPROTO_CUSTOMERS_SPACE: own.customers }, async () => {
        // The gates now read the new admin space: the added staff member is
        // in, with write access, and the real stack's staff are not.
        expect(await ok("at.happyproto.actor.getProfile", "customer")).toMatchObject({
          isMember: true,
          access: "write",
        });
        await fails("at.happyproto.admin.listCustomers", "staff", "Forbidden");

        const second = await ok(nsid, "outsider", { input: { staff } });
        expect(second).toEqual({
          adminSpace: { uri: own.admin, created: false },
          customersSpace: { uri: own.customers, created: false },
          staffAdded: [],
        });
      });
    });

    await deleteOwnSpaces(owner);
    expect(await spacesOf(owner, "at.happyproto.admin")).toEqual([]);
  });
});
