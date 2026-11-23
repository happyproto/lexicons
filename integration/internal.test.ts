/**
 * at.happyproto.internal.* (HAP-463 phase 2) on a real HappyView v3, set up
 * as api.happyproto.at is: a linked-account service identity naming
 * HappyProto's account, and a `specific` service entry `#happyproto_internal`
 * listing only getOwnerContacts.
 *
 * The provisioner signs its service-auth token as its own did:web. Here a
 * stand-in signs instead: the outsider account, whose PDS mints the token
 * (com.atproto.server.getServiceAuth) and whose did:plc HappyView resolves
 * through the stack's PLC directory. The path HappyView takes is the same:
 * aud, lxm and the service entry are checked, then the issuer's #atproto key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sessionHeaders } from "./session";
import { HAPPYVIEW_URL, PDS_URL, setVariable, stack, type Account, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const METHOD = "at.happyproto.internal.getOwnerContacts";
const FRAGMENT = "#happyproto_internal";
const SPACE = "at://did:plc:nobody/space/at.happyproto.preferences/self";

let s: Stack;
let entryId: number | undefined;
let priorIdentity: any = null;

// As the operator, a super user: the service identity and entries need
// settings:manage, which the deploy's API key doesn't have.
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${HAPPYVIEW_URL}/admin${path}`, {
    ...init,
    headers: {
      ...sessionHeaders(s.accounts.happyproto.did),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

async function must(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** A service-auth token for `aud` and `lxm`, signed by `who`'s PDS. */
async function serviceToken(who: Account, aud: string, lxm: string): Promise<string> {
  const url = new URL("/xrpc/com.atproto.server.getServiceAuth", PDS_URL);
  url.searchParams.set("aud", aud);
  url.searchParams.set("lxm", lxm);
  const body = await must(await fetch(url, { headers: { authorization: `Bearer ${who.accessJwt}` } }), "getServiceAuth");
  return body.token;
}

async function asService(token: string, spaces: string[]): Promise<Response> {
  const url = new URL(`/xrpc/${METHOD}`, HAPPYVIEW_URL);
  for (const space of spaces) url.searchParams.append("spaces", space);
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

function headers(who: Account): Record<string, string> {
  return {
    ...sessionHeaders(who.did),
    "x-client-key": s.client.key,
    "x-client-secret": s.client.secret,
    "content-type": "application/json",
  };
}

async function preferencesSpace(who: Account): Promise<string | undefined> {
  const url = new URL("/xrpc/com.atproto.space.listSpaces", HAPPYVIEW_URL);
  url.searchParams.set("spaceType", "at.happyproto.preferences");
  const body = await must(await fetch(url, { headers: headers(who) }), "listSpaces");
  return (body.spaces as { uri: string }[]).map((x) => x.uri)[0];
}

beforeAll(async () => {
  s = await stack();
  priorIdentity = await must(await admin("/service-identity"), "read the service identity");
  await must(
    await admin("/service-identity", {
      method: "PUT",
      // `did` as well: the stack's HappyView (beta.20) reads the instance
      // DID only from it; beta.24, which api.happyproto.at runs, also falls
      // back to attached_account_did.
      body: JSON.stringify({
        mode: "attach_account",
        did: s.accounts.happyproto.did,
        attached_account_did: s.accounts.happyproto.did,
      }),
    }),
    "attach the service identity",
  );
  const entry = await must(
    await admin("/service-entries", {
      method: "POST",
      body: JSON.stringify({ fragment_id: FRAGMENT, service_type: "HappyProtoInternal" }),
    }),
    "create the service entry",
  );
  entryId = entry.id;
  await must(
    await admin(`/service-entries/${entryId}`, { method: "PUT", body: JSON.stringify({ access_mode: "specific" }) }),
    "make the entry specific",
  );
  await must(
    await admin(`/service-entries/${entryId}/xrpcs`, { method: "POST", body: JSON.stringify({ lexicon_ids: [METHOD] }) }),
    "list getOwnerContacts on the entry",
  );
  await setVariable(s.apiKey, "PROVISIONER_DID", s.accounts.outsider.did);
}, 120_000);

afterAll(async () => {
  if (!s) return;
  await setVariable(s.apiKey, "PROVISIONER_DID", s.variables.PROVISIONER_DID);
  if (entryId !== undefined) await admin(`/service-entries/${entryId}`, { method: "DELETE" });
  const mode = priorIdentity?.mode ?? "not_exposed";
  await admin("/service-identity", {
    method: "PUT",
    body: JSON.stringify({ mode, did: priorIdentity?.did ?? null, attached_account_did: priorIdentity?.attached_account_did ?? null }),
  });
});

describe("internal.getOwnerContacts", () => {
  test("refuses every signed-in account as Forbidden", async () => {
    for (const who of ["happyproto", "staff", "customer"] as const) {
      await fails(METHOD, who, "Forbidden", { params: { spaces: SPACE } });
    }
  });

  test("answers the provisioner's service-auth call with the owner's contact", async () => {
    const staff = s.accounts.staff;
    await ok("at.happyproto.actor.syncAccount", "staff", { input: { idempotencyKey: crypto.randomUUID() } });
    await ok("at.happyproto.actor.setContactEmail", "staff", {
      input: { email: "staff-notices@example.com", idempotencyKey: crypto.randomUUID() },
    });
    const uri = await preferencesSpace(staff);
    expect(uri).toBeDefined();
    const shown = await ok("at.happyproto.actor.getContact", "staff");

    const token = await serviceToken(s.accounts.outsider, `${s.accounts.happyproto.did}${FRAGMENT}`, METHOD);
    const res = await asService(token, [uri!]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts).toEqual([
      { space: uri, status: "ok", creator: staff.did, email: shown.email, maintenance: true },
    ]);
  });

  test("refuses the same call through another service entry, or from anyone else", async () => {
    const uri = (await preferencesSpace(s.accounts.staff)) ?? SPACE;
    // The space host entry doesn't list this method.
    const wrongEntry = await serviceToken(
      s.accounts.outsider,
      `${s.accounts.happyproto.did}#atproto_space_host`,
      METHOD,
    );
    expect((await asService(wrongEntry, [uri])).status).not.toBe(200);
    // The right entry, but not the provisioner.
    const notProvisioner = await serviceToken(s.accounts.customer, `${s.accounts.happyproto.did}${FRAGMENT}`, METHOD);
    const res = await asService(notProvisioner, [uri]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Forbidden");
  });
});
