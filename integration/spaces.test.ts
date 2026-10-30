/**
 * admin.createSpaces, and the gates' derivation of both spaces from
 * HAPPYPROTO_DID, on a real HappyView v3.
 *
 * setup.ts bootstraps the stack's own spaces by calling createSpaces as
 * `happyproto`, so every other file already runs against derived uris. This
 * file checks what that bootstrap made, who else may call it, and -- with
 * HAPPYPROTO_DID pointed at `outsider` for one test -- a genuine first call
 * and its repeat, on spaces that test removes again.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessionHeaders } from "./session";
import { HAPPYVIEW_URL, setVariable, stack, type Account, type Stack } from "./setup";
import { call, fails, ok } from "./xrpc";

const nsid = "at.happyproto.admin.createSpaces";
const MEMBER_LIST = "com.atproto.simplespace.defs#memberListPolicy";

let s: Stack;

const uris = (did: string) => ({
  admin: `at://${did}/space/at.happyproto.admin/main`,
  customers: `at://${did}/space/at.happyproto.customers/main`,
});

function headers(who: Account): Record<string, string> {
  return {
    ...sessionHeaders(who.did),
    "x-client-key": s.client.key,
    "x-client-secret": s.client.secret,
    "content-type": "application/json",
  };
}

/** The space as its creator reads it through simplespace.getSpace, or null. */
async function getSpace(who: Account, uri: string): Promise<any | null> {
  const url = new URL("/xrpc/com.atproto.simplespace.getSpace", HAPPYVIEW_URL);
  url.searchParams.set("space", uri);
  const res = await fetch(url, { headers: headers(who) });
  return res.ok ? res.json() : null;
}

/** Delete the space as its creator; a space that is already gone is fine. */
async function deleteSpace(who: Account, uri: string): Promise<void> {
  await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.simplespace.deleteSpace`, {
    method: "POST",
    headers: headers(who),
    body: JSON.stringify({ space: uri }),
  });
}

async function withDid<T>(value: string, body: () => Promise<T>): Promise<T> {
  try {
    await setVariable(s.apiKey, "HAPPYPROTO_DID", value);
    return await body();
  } finally {
    await setVariable(s.apiKey, "HAPPYPROTO_DID", s.variables.HAPPYPROTO_DID);
  }
}

beforeAll(async () => {
  s = await stack();
}, 180_000);

afterAll(async () => {
  // The first-call test's spaces, should it have failed before removing them.
  const own = uris(s.accounts.outsider.did);
  await deleteSpace(s.accounts.outsider, own.admin);
  await deleteSpace(s.accounts.outsider, own.customers);
}, 30_000);

describe("the bootstrapped spaces", () => {
  test("are at the uris derived from HAPPYPROTO_DID", () => {
    expect(s.spaces).toEqual(uris(s.accounts.happyproto.did));
  });

  test("are member-only to read and to write, and named", async () => {
    const admin = await getSpace(s.accounts.happyproto, s.spaces.admin);
    const customers = await getSpace(s.accounts.happyproto, s.spaces.customers);
    for (const space of [admin, customers]) {
      expect(space.config.readPolicy).toEqual({ $type: MEMBER_LIST });
      expect(space.config.writePolicy).toEqual({ $type: MEMBER_LIST });
    }
    expect(admin.space).toMatchObject({
      display_name: "HappyProto admins",
      description: "Membership of this space grants access to the HappyProto dashboard.",
    });
    expect(customers.space).toMatchObject({ display_name: "HappyProto customers" });
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
      const own = uris(s.accounts[who].did);
      expect(await getSpace(s.accounts[who], own.admin)).toBeNull();
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

  test("an unset or malformed HAPPYPROTO_DID is Forbidden, and every gate refuses", async () => {
    for (const value of ["", "happyproto", `${s.accounts.happyproto.did}/space/x`]) {
      await withDid(value, async () => {
        await fails(nsid, "happyproto", "Forbidden", { input: {} });
        await fails("at.happyproto.admin.listCustomers", "staff", "Forbidden");
        await fails("at.happyproto.admin.listCustomers", "happyproto", "Forbidden");
        await fails("at.happyproto.server.listPlans", "customer", "Forbidden");
      });
    }
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
    const own = uris(owner.did);
    // A rerun against a stack where this test failed half-way starts clean.
    await deleteSpace(owner, own.admin);
    await deleteSpace(owner, own.customers);

    await withDid(owner.did, async () => {
      // `customer` twice, and the owner, who is already a member as creator.
      const staff = [s.accounts.customer.did, s.accounts.customer.did, owner.did];
      const first = await ok(nsid, "outsider", { input: { staff } });
      expect(first).toEqual({
        adminSpace: { uri: own.admin, created: true },
        customersSpace: { uri: own.customers, created: true },
        staffAdded: [s.accounts.customer.did],
      });

      for (const uri of [own.admin, own.customers]) {
        const space = await getSpace(owner, uri);
        expect(space.config.readPolicy).toEqual({ $type: MEMBER_LIST });
        expect(space.config.writePolicy).toEqual({ $type: MEMBER_LIST });
      }

      // The gates now read the new admin space: the added staff member is in,
      // with write access, and the real stack's staff are not.
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

    await deleteSpace(owner, own.admin);
    await deleteSpace(owner, own.customers);
    expect(await getSpace(owner, own.admin)).toBeNull();
  });
});
