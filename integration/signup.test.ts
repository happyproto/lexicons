/**
 * Open signup (HAP-509) on a real HappyView v3 against the fake provisioner:
 * with HAPPYPROTO_SIGNUP=open the customer gate admits any signed-in account,
 * and a non-member's terms acceptance goes to the provisioner's signup route.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { setVariable, stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const key = () => crypto.randomUUID();
const TERMS = { termsVersion: "beta-2026-11", textVersion: "v1", text: "I agree to the Beta Terms." };

let s: Stack;

async function open(on: boolean): Promise<void> {
  await setVariable(s.apiKey, "HAPPYPROTO_SIGNUP", on ? "open" : "closed");
}

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
});

afterEach(async () => {
  await open(false);
}, 30_000);

const paths = async () => (await provisioner.requests()).map((r: { path: string }) => r.path);

describe("open signup", () => {
  test("closed: someone outside the space is not a customer and can't accept the terms", async () => {
    await open(false);
    const profile = await ok("at.happyproto.actor.getProfile", "outsider");
    expect(profile).toMatchObject({ isCustomer: false, signupOpen: false, inCustomersSpace: false });
    await fails("at.happyproto.actor.acceptTerms", "outsider", "Forbidden", { input: { ...TERMS, idempotencyKey: key() } });
    await fails("at.happyproto.server.listInstances", "outsider", "Forbidden");
  });

  test("open: anyone signed in is a customer, and accepting the terms signs them up", async () => {
    await open(true);
    const profile = await ok("at.happyproto.actor.getProfile", "outsider");
    expect(profile).toMatchObject({ isCustomer: true, signupOpen: true, inCustomersSpace: false });

    expect(await ok("at.happyproto.actor.acceptTerms", "outsider", { input: { ...TERMS, idempotencyKey: key() } })).toEqual({
      termsVersion: "beta-2026-11",
      accepted: true,
    });
    expect(await paths()).toContain("/v1/account/signup");
    await ok("at.happyproto.server.listInstances", "outsider");
  });

  test("open: a member of the customers space only accepts the terms", async () => {
    await open(true);
    expect((await ok("at.happyproto.actor.getProfile", "customer")).inCustomersSpace).toBe(true);
    await ok("at.happyproto.actor.acceptTerms", "customer", { input: { ...TERMS, idempotencyKey: key() } });
    const p = await paths();
    expect(p).toContain("/v1/account/terms");
    expect(p).not.toContain("/v1/account/signup");
  });

  test("open: the provisioner's refusal comes back", async () => {
    await open(true);
    await provisioner.script("POST", "/v1/account/signup", 403, { error: "SignupsClosed", message: "signup is closed" });
    await fails("at.happyproto.actor.acceptTerms", "outsider", "SignupsClosed", {
      input: { ...TERMS, idempotencyKey: key() },
    });
  });
});
