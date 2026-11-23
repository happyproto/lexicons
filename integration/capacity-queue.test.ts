/**
 * The capacity queue as a customer sees it (HAP-511): actor.getAccount's
 * capacityWait, and actor.leaveCapacityQueue, on a real HappyView v3 against
 * the fake provisioner.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
});

describe("capacity queue", () => {
  test("a queued customer sees their place and can leave", async () => {
    await provisioner.state({
      capacityWaits: {
        [s.accounts.customer.did]: { plan: "small", queued_at: "2026-12-07T15:00:00Z", notified_at: null },
      },
    });
    const account = await ok("at.happyproto.actor.getAccount", "customer");
    expect(account.capacityWait).toEqual({ plan: "small", queuedAt: "2026-12-07T15:00:00Z", notified: false });
    expect(account.suspended).toBe(false);
    expect(account.deletedInstanceCount).toBe(0);

    const left = await ok("at.happyproto.actor.leaveCapacityQueue", "customer", {
      input: { idempotencyKey: crypto.randomUUID() },
    });
    expect(left).toEqual({ removed: true });
    expect((await ok("at.happyproto.actor.getAccount", "customer")).capacityWait).toBeUndefined();
  });

  test("only customers leave the queue", async () => {
    await fails("at.happyproto.actor.leaveCapacityQueue", "outsider", "Forbidden", {
      input: { idempotencyKey: crypto.randomUUID() },
    });
  });
});
