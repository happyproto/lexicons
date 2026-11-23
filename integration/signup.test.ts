/**
 * Open signup -- admin.createSignupInvite, actor.signUp and getProfile's
 * signupOpen -- on a real HappyView v3, through a real standing invite: one
 * with no use limit and no expiry, which every signup spends.
 *
 * Minting the invite is a spaces write, which HappyView allows only to the
 * customers space's creator or a HappyView super user; `staff` is made a
 * super user for this file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { ensureTestUser } from "./session";
import { removeMember, setVariable, stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const signUp = "at.happyproto.actor.signUp";
const getProfile = "at.happyproto.actor.getProfile";
const key = () => crypto.randomUUID();
const TERMS = { termsVersion: "beta-2026-11", textVersion: "v1", text: "I agree to the Beta Terms." };

let s: Stack;
let token: string;

async function out(did: string): Promise<void> {
  try {
    await removeMember(s.accounts.happyproto, s.client.key, s.spaces.customers, did);
  } catch {
    // Already not a member.
  }
}

async function open(on: boolean): Promise<void> {
  await setVariable(s.apiKey, "HAPPYPROTO_SIGNUP", on ? "open" : "closed");
}

beforeAll(async () => {
  s = await stack();
  await ensureTestUser(s.accounts.staff.did, true);
  await provisioner.reset();
  await provisioner.state({ staff: [s.accounts.staff.did] });
  ({ token } = await ok("at.happyproto.admin.createSignupInvite", "staff", { input: {} }));
  await setVariable(s.apiKey, "HAPPYPROTO_SIGNUP_INVITE", token);
  await out(s.accounts.outsider.did);
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  await provisioner.state({ staff: [s.accounts.staff.did] });
});

afterEach(async () => {
  await open(false);
  await out(s.accounts.outsider.did);
}, 30_000);

afterAll(async () => {
  await setVariable(s.apiKey, "HAPPYPROTO_SIGNUP_INVITE", "none");
});

describe("admin.createSignupInvite", () => {
  test("is staff only", async () => {
    await fails("at.happyproto.admin.createSignupInvite", "outsider", "Forbidden", { input: {} });
  });
});

describe("actor.signUp", () => {
  test("is refused while signup is closed, and getProfile says so", async () => {
    await open(false);
    expect((await ok(getProfile, "outsider")).signupOpen).toBe(false);
    await fails(signUp, "outsider", "SignupClosed", { input: { ...TERMS, idempotencyKey: key() } });
    expect((await ok(getProfile, "outsider")).isCustomer).toBe(false);
  });

  test("joins the caller through the standing invite, which stays usable", async () => {
    await open(true);
    expect((await ok(getProfile, "outsider")).signupOpen).toBe(true);
    const joined = await ok(signUp, "outsider", { input: { ...TERMS, idempotencyKey: key() } });
    expect(joined).toEqual({ isCustomer: true, joined: true, termsVersion: "beta-2026-11" });
    expect((await ok(getProfile, "outsider")).isCustomer).toBe(true);
    const asked = (await provisioner.requests()).filter((r: { path: string }) => r.path === "/v1/account/signup");
    expect(asked).toHaveLength(1);

    // Out and back in: the same invite admits again, as it must for every signup.
    await out(s.accounts.outsider.did);
    const again = await ok(signUp, "outsider", { input: { ...TERMS, idempotencyKey: key() } });
    expect(again.joined).toBe(true);
  });

  test("a customer only records the terms", async () => {
    await open(true);
    const r = await ok(signUp, "customer", { input: { ...TERMS, idempotencyKey: key() } });
    expect(r).toEqual({ isCustomer: true, joined: false, termsVersion: "beta-2026-11" });
  });

  test("a provisioner refusal joins nothing", async () => {
    await open(true);
    await provisioner.script("POST", "/v1/account/signup", 429, {
      error: "SignupsPaused",
      message: "signups are paused for this hour; try again later",
      details: { window: "hour" },
    });
    await fails(signUp, "outsider", "SignupsPaused", { input: { ...TERMS, idempotencyKey: key() } });
    expect((await ok(getProfile, "outsider")).isCustomer).toBe(false);
  });
});
