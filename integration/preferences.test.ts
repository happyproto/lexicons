/**
 * The preferences space (HAP-463) on a real HappyView v3: syncAccount
 * creates it as the caller, managed by HappyProto's app, and the contact
 * scripts read and write it as the owner, against the fake provisioner.
 *
 * The harness signs in with a bare session cookie and no PDS session behind
 * it, so sign-in never reads an address and never seeds one (that is proven
 * in scripts/preferences.test.ts). Every test here runs in order on one
 * customer, whose space HappyView keeps between tests while the fake
 * provisioner is reset only once.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { sessionHeaders } from "./session";
import { HAPPYVIEW_URL, stack, type Account, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const actor = (name: string) => `at.happyproto.actor.${name}`;
const TYPE = "at.happyproto.preferences";

let s: Stack;

function headers(who: Account): Record<string, string> {
  return {
    ...sessionHeaders(who.did),
    "x-client-key": s.client.key,
    "x-client-secret": s.client.secret,
    "content-type": "application/json",
  };
}

/** The uris of the preferences spaces `who` belongs to. */
async function preferenceSpaces(who: Account): Promise<string[]> {
  const url = new URL("/xrpc/com.atproto.space.listSpaces", HAPPYVIEW_URL);
  url.searchParams.set("spaceType", TYPE);
  const res = await fetch(url, { headers: headers(who) });
  if (!res.ok) throw new Error(`listSpaces answered ${res.status}`);
  return ((await res.json()).spaces as { uri: string }[]).map((space) => space.uri);
}

/** The space as its creator reads it, or null. */
async function getSpace(who: Account, uri: string): Promise<any | null> {
  const url = new URL("/xrpc/com.atproto.space.getSpace", HAPPYVIEW_URL);
  url.searchParams.set("space", uri);
  const res = await fetch(url, { headers: headers(who) });
  return res.ok ? res.json() : null;
}

const key = () => ({ idempotencyKey: crypto.randomUUID() });
const lastToken = async () => (await provisioner.links()).filter((l) => !l.used).at(-1)!.token;

beforeAll(async () => {
  s = await stack();
  await provisioner.reset();
  // Another file's sign-ins may have created the customer's space while the
  // fake provisioner forgot it; start from none.
  for (const uri of await preferenceSpaces(s.accounts.customer)) {
    await fetch(`${HAPPYVIEW_URL}/xrpc/com.atproto.space.deleteSpace`, {
      method: "POST",
      headers: headers(s.accounts.customer),
      body: JSON.stringify({ space: uri }),
    });
  }
}, 180_000);

describe("the preferences space", () => {
  test("getContact answers the defaults before sign-in has made one", async () => {
    expect(await ok(actor("getContact"), "customer")).toEqual({ verified: false, maintenance: true });
    expect(await preferenceSpaces(s.accounts.customer)).toEqual([]);
  });

  test("sign-in creates it as the customer, on a DID of its own, and records it", async () => {
    await ok(actor("syncAccount"), "customer", { input: key() });
    const [uri, ...more] = await preferenceSpaces(s.accounts.customer);
    expect(more).toEqual([]);
    expect(uri).toMatch(/^at:\/\/did:plc:[a-z2-7]+\/space\/at\.happyproto\.preferences\/self$/);
    const space = await getSpace(s.accounts.customer, uri);
    expect(space).not.toBeNull();
    expect(JSON.stringify(space)).toContain(`${s.accounts.happyproto.did}#happyproto_app`);
    const requests = await provisioner.requests();
    expect(requests.some((r) => r.path === "/v1/account/preferences-space" && r.body?.uri === uri)).toBe(true);

    // A second sign-in finds it and creates no other.
    await ok(actor("syncAccount"), "customer", { input: key() });
    expect(await preferenceSpaces(s.accounts.customer)).toEqual([uri]);
  });

  test("a first address is written and sent a link, and the link proves it", async () => {
    const set = await ok(actor("setContactEmail"), "customer", { input: { email: "first@example.com", ...key() } });
    expect(set.sent).toBe(true);
    expect(await ok(actor("getContact"), "customer")).toEqual({
      email: "first@example.com",
      verified: false,
      maintenance: true,
    });
    await ok(actor("confirmContactEmail"), "customer", { input: { token: await lastToken(), ...key() } });
    expect((await ok(actor("getContact"), "customer")).verified).toBe(true);
  });

  test("a change waits for its link, then replaces the address", async () => {
    await ok(actor("setContactEmail"), "customer", { input: { email: "second@example.com", ...key() } });
    expect(await ok(actor("getContact"), "customer")).toEqual({
      email: "first@example.com",
      verified: true,
      pendingEmail: "second@example.com",
      pendingVerified: false,
      maintenance: true,
    });
    await ok(actor("confirmContactEmail"), "customer", { input: { token: await lastToken(), ...key() } });
    expect(await ok(actor("getContact"), "customer")).toEqual({
      email: "second@example.com",
      verified: true,
      maintenance: true,
    });
  });

  test("another account's link is refused", async () => {
    await ok(actor("setContactEmail"), "customer", { input: { email: "third@example.com", ...key() } });
    await fails(actor("confirmContactEmail"), "staff", "InvalidLink", { input: { token: await lastToken(), ...key() } });
  });

  test("maintenance emails switch off and on", async () => {
    expect(await ok(actor("setNotices"), "customer", { input: { maintenance: false, ...key() } })).toEqual({
      maintenance: false,
    });
    expect((await ok(actor("getContact"), "customer")).maintenance).toBe(false);
    await ok(actor("setNotices"), "customer", { input: { maintenance: true, ...key() } });
    expect((await ok(actor("getContact"), "customer")).maintenance).toBe(true);
  });

  test("removing the address leaves none, and sign-in does not write one back", async () => {
    expect(await ok(actor("removeContactEmail"), "customer", { input: key() })).toEqual({ removed: true });
    await ok(actor("syncAccount"), "customer", { input: key() });
    expect(await ok(actor("getContact"), "customer")).toEqual({ verified: false, maintenance: true });
  });

  test("anyone who is neither a customer nor staff is refused before anything is sent", async () => {
    await provisioner.reset();
    await fails(actor("getContact"), "outsider", "Forbidden");
    await fails(actor("setContactEmail"), "outsider", "Forbidden", { input: { email: "x@example.com", ...key() } });
    expect(await provisioner.requests()).toEqual([]);
  });
});
