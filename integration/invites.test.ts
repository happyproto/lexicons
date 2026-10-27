/**
 * Customer invites -- admin.createInvites and actor.acceptInvite -- on a real
 * HappyView v3, using HappyView's own space invites.
 *
 * Making an invite is a spaces write, which HappyView allows only to the
 * customers space's creator or a HappyView super user, as with addCustomer;
 * `staff` is made a super user for this file. Redeeming one is open to any
 * signed-in account, and the token is the only authority.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import pg from "pg";
import { provisioner } from "./fakes";
import { DB_URL, ensureTestUser } from "./session";
import { removeMember, stack, type Stack } from "./setup";
import { call, fails, ok } from "./xrpc";

const createInvites = "at.happyproto.admin.createInvites";
const acceptInvite = "at.happyproto.actor.acceptInvite";
const listInvites = "at.happyproto.admin.listInvites";
const key = () => crypto.randomUUID();
const emails = (n: number) => Array.from({ length: n }, (_, i) => `invitee${i}-${key().slice(0, 8)}@example.com`);

let s: Stack;

const customersOf = async (): Promise<string[]> =>
  (await ok("at.happyproto.admin.listCustomers", "staff")).customers.map((c: { did: string }) => c.did);

async function mint(count = 1, expiresInDays?: number): Promise<string[]> {
  const { invites } = await ok(createInvites, "staff", {
    input: { emails: emails(count), expiresInDays, idempotencyKey: key() },
  });
  return invites.map((i: { token: string }) => i.token);
}

const accept = (who: "outsider" | "customer", token: unknown) =>
  ok(acceptInvite, who, { input: { token, idempotencyKey: key() } });

async function outsiderOut(): Promise<void> {
  try {
    await removeMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.outsider.did);
  } catch {
    // Already not a member.
  }
}

beforeAll(async () => {
  s = await stack();
  await ensureTestUser(s.accounts.staff.did, true);
  await outsiderOut();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  await provisioner.state({ staff: [s.accounts.staff.did] });
});

afterEach(async () => {
  await ensureTestUser(s.accounts.staff.did, true);
  await outsiderOut();
}, 30_000);

describe("admin.createInvites", () => {
  test("mints one invite per address, each distinct, expiring in 14 days by default", async () => {
    const before = Date.now();
    const addresses = emails(3);
    const { invites } = await ok(createInvites, "staff", { input: { emails: addresses, idempotencyKey: key() } });
    expect(invites).toHaveLength(3);
    expect(invites.map((i: { email: string }) => i.email)).toEqual(addresses);
    expect(new Set(invites.map((i: { token: string }) => i.token)).size).toBe(3);
    for (const invite of invites) {
      expect(invite.token).toMatch(/^[0-9a-f]+$/);
      const days = (Date.parse(invite.expiresAt) - before) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    }
  });

  test("expiresInDays sets the expiry", async () => {
    const { invites } = await ok(createInvites, "staff", {
      input: { emails: emails(1), expiresInDays: 2, idempotencyKey: key() },
    });
    const days = (Date.parse(invites[0].expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
  });

  test("records each address with the provisioner, and never the token", async () => {
    const addresses = emails(2);
    const { invites } = await ok(createInvites, "staff", { input: { emails: addresses, idempotencyKey: key() } });
    const sent = (await provisioner.requests()).filter((r) => r.path === "/v1/invites");
    expect(sent).toHaveLength(1);
    expect(sent[0].headers["x-actor-did"]).toBe(s.accounts.staff.did);
    expect(sent[0].body.invites.map((i: { email: string }) => i.email)).toEqual(addresses);
    const listed = (await ok(listInvites, "staff")).invites;
    expect(listed.map((i: { email: string }) => i.email).sort()).toEqual([...addresses].sort());
    expect(listed.every((i: { status: string }) => i.status === "pending")).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(invites[0].token);
  });

  test("addresses are trimmed and lowercased", async () => {
    const { invites } = await ok(createInvites, "staff", {
      input: { emails: ["  Ada.Example@Example.COM "], idempotencyKey: key() },
    });
    expect(invites[0].email).toBe("ada.example@example.com");
  });

  test("bad addresses, counts, expiries or keys are InvalidRequest, and nothing is minted", async () => {
    const one = emails(1);
    for (const input of [
      { emails: [], idempotencyKey: key() },
      { emails: emails(51), idempotencyKey: key() },
      { emails: ["not-an-address"], idempotencyKey: key() },
      { emails: ["a@b.co", "A@B.co"], idempotencyKey: key() },
      { emails: "a@b.co", idempotencyKey: key() },
      { idempotencyKey: key() },
      { emails: one, expiresInDays: 0, idempotencyKey: key() },
      { emails: one, expiresInDays: 31, idempotencyKey: key() },
      { emails: one },
      { emails: one, idempotencyKey: "nope" },
    ]) {
      await fails(createInvites, "staff", "InvalidRequest", { input });
    }
    expect(await provisioner.requests()).toEqual([]);
  });

  test("when the provisioner refuses, no token is handed out", async () => {
    await provisioner.script("POST", "/v1/invites", 500, { error: "Internal", message: "SENTINEL" });
    const reply = await fails(createInvites, "staff", "Upstream", { input: { emails: emails(1), idempotencyKey: key() } });
    expect(reply.text).not.toContain("SENTINEL");
    expect(reply.body.invites).toBeUndefined();
  });

  test("staff the provisioner does not know are Forbidden", async () => {
    await provisioner.state({ staff: [] });
    await fails(createInvites, "staff", "Forbidden", { input: { emails: emails(1), idempotencyKey: key() } });
    await fails(listInvites, "staff", "Forbidden");
  });

  test("is Forbidden to a customer and an outsider", async () => {
    const input = { emails: emails(1), idempotencyKey: key() };
    await fails(createInvites, "customer", "Forbidden", { input });
    await fails(createInvites, "outsider", "Forbidden", { input });
    await fails(listInvites, "customer", "Forbidden");
    await fails(listInvites, "outsider", "Forbidden");
  });

  test("HappyView refuses an anonymous call before the script runs", async () => {
    expect((await call(createInvites, null, { input: { emails: emails(1), idempotencyKey: key() } })).status).toBe(401);
  });

  test("staff who may not change the space are Forbidden, saying why", async () => {
    await ensureTestUser(s.accounts.staff.did, false);
    const reply = await fails(createInvites, "staff", "Forbidden", { input: { emails: emails(1), idempotencyKey: key() } });
    expect(reply.body.message).toContain("super user");
  });
});

describe("actor.acceptInvite", () => {
  test("makes the caller a customer, once", async () => {
    const [token] = await mint();
    await fails("at.happyproto.server.listPlans", "outsider", "Forbidden");

    expect(await accept("outsider", token)).toEqual({ isCustomer: true, joined: true });
    await ok("at.happyproto.server.listPlans", "outsider");
    expect(await customersOf()).toContain(s.accounts.outsider.did);
    const profile = await ok("at.happyproto.actor.getProfile", "outsider");
    expect(profile.isCustomer).toBe(true);
  });

  test("pairs the invite's address with the account that redeemed it", async () => {
    const [address] = emails(1);
    const { invites } = await ok(createInvites, "staff", { input: { emails: [address], idempotencyKey: key() } });
    await accept("outsider", invites[0].token);
    const listed = (await ok(listInvites, "staff")).invites.find((i: { email: string }) => i.email === address);
    expect(listed.status).toBe("redeemed");
    expect(listed.redeemedDid).toBe(s.accounts.outsider.did);
    expect(typeof listed.redeemedAt).toBe("string");
  });

  test("a provisioner failure on redeem still admits the invitee", async () => {
    const [token] = await mint();
    await provisioner.script("POST", "/v1/invites/redeem", 500, { error: "Internal", message: "down" });
    expect(await accept("outsider", token)).toEqual({ isCustomer: true, joined: true });
    expect(await customersOf()).toContain(s.accounts.outsider.did);
  });

  test("an existing customer is told so, and the invite is not spent", async () => {
    const [token] = await mint();
    expect(await accept("customer", token)).toEqual({ isCustomer: true, joined: false });
    expect(await accept("outsider", token)).toEqual({ isCustomer: true, joined: true });
  });

  test("the same link opened twice by its invitee is not an error", async () => {
    const [token] = await mint();
    await accept("outsider", token);
    expect(await accept("outsider", token)).toEqual({ isCustomer: true, joined: false });
  });

  test("a used invite is InviteUsed for anyone else", async () => {
    const [token] = await mint();
    await accept("outsider", token);
    await outsiderOut();
    await fails(acceptInvite, "outsider", "InviteUsed", { input: { token, idempotencyKey: key() } });
    expect(await customersOf()).not.toContain(s.accounts.outsider.did);
  });

  test("an expired invite is InviteExpired", async () => {
    const [token] = await mint();
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    try {
      // Every invite this file made is past; the newest is this one.
      await db.query("update happyview_space_invites set expires_at = '2000-01-01T00:00:00+00:00' where uses = 0");
    } finally {
      await db.end();
    }
    await fails(acceptInvite, "outsider", "InviteExpired", { input: { token, idempotencyKey: key() } });
    expect(await customersOf()).not.toContain(s.accounts.outsider.did);
  });

  test("an unknown token is InvalidInvite, a malformed one InvalidRequest", async () => {
    await fails(acceptInvite, "outsider", "InvalidInvite", { input: { token: "ab".repeat(24), idempotencyKey: key() } });
    for (const token of ["", "not hex!", "a".repeat(129), 42, undefined]) {
      await fails(acceptInvite, "outsider", "InvalidRequest", { input: { token, idempotencyKey: key() } });
    }
    const [token] = await mint();
    await fails(acceptInvite, "outsider", "InvalidRequest", { input: { token } });
    expect(await customersOf()).not.toContain(s.accounts.outsider.did);
  });

  test("HappyView refuses an anonymous call before the script runs, and nothing is spent", async () => {
    const [token] = await mint();
    expect((await call(acceptInvite, null, { input: { token, idempotencyKey: key() } })).status).toBe(401);
    expect(await accept("outsider", token)).toEqual({ isCustomer: true, joined: true });
  });
});
