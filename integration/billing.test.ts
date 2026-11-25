/**
 * Billing as a customer sees it: actor.createCheckout, actor.confirmCheckout,
 * actor.createBillingPortal and actor.getAccount's billing, on a real
 * HappyView v3 against the fake provisioner.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const actor = (name: string) => `at.happyproto.actor.${name}`;
const key = () => crypto.randomUUID();

let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
});

describe("billing", () => {
  test("a trial Checkout, confirmed, shows on the account", async () => {
    expect((await ok(actor("getAccount"), "customer")).billing).toBeUndefined();

    const started = await ok(actor("createCheckout"), "customer", {
      input: { plan: "small", payment: "trial", code: "WAIT-1", idempotencyKey: key() },
    });
    expect(started).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1", expiresAt: "2026-11-26T15:00:00Z" });
    const [asked] = (await provisioner.requests()).filter((r: { path: string }) => r.path === "/v1/billing/checkout");
    expect(asked.body).toEqual({ plan: "small", payment: "trial", code: "WAIT-1" });

    const confirmed = await ok(actor("confirmCheckout"), "customer", {
      input: { sessionId: "cs_test_1", idempotencyKey: key() },
    });
    expect(confirmed.billing).toMatchObject({ status: "trialing", hasPaymentMethod: false, trialEndsAt: "2026-12-09T15:00:00Z" });
    expect(confirmed.billing.stripeCustomerId).toBeUndefined();

    const account = await ok(actor("getAccount"), "customer");
    expect(account.billing).toEqual(confirmed.billing);
    expect(account.trialPoolFull).toBe(false);
  });

  test("the Portal needs a subscription, then opens on the card", async () => {
    await fails(actor("createBillingPortal"), "customer", "PaymentRequired", {
      input: { flow: "paymentMethod", idempotencyKey: key() },
    });
    await ok(actor("createCheckout"), "customer", { input: { plan: "small", payment: "card", idempotencyKey: key() } });
    await ok(actor("confirmCheckout"), "customer", { input: { sessionId: "cs_test_1", idempotencyKey: key() } });
    expect(
      await ok(actor("createBillingPortal"), "customer", { input: { flow: "paymentMethod", idempotencyKey: key() } }),
    ).toEqual({ url: "https://billing.stripe.com/p/session/payment_method_update" });
  });

  test("a used code is refused in the provisioner's words", async () => {
    await fails(actor("createCheckout"), "customer", "CodeUsed", {
      input: { plan: "small", payment: "trial", code: "USED", idempotencyKey: key() },
    });
  });

  test("an unknown Checkout confirms nothing, and outsiders are refused", async () => {
    await fails(actor("confirmCheckout"), "customer", "NotFound", {
      input: { sessionId: "cs_test_9", idempotencyKey: key() },
    });
    await fails(actor("createCheckout"), "outsider", "Forbidden", {
      input: { plan: "small", payment: "trial", idempotencyKey: key() },
    });
  });
});
