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

const GONE = "99999999-9999-4999-8999-999999999999";
const later = new Date(Date.now() + 5 * 86_400_000).toISOString();

describe("deleted instances in their grace period", () => {
  test("are listed, and Delete now frees them", async () => {
    await provisioner.state({
      tenants: [
        {
          id: GONE,
          slug: "cust-gone",
          owner_did: s.accounts.customer.did,
          plan_id: "small",
          host_id: null,
          happyview_version: "3.0.0-alpha.4",
          public_url: "https://cust-gone.happyview.app",
          image: "ghcr.io/gamesgamesgamesgamesgames/happyview",
          routed: true,
          desired_state: "deleted",
          observed_state: "stopped",
          spec_hash: null,
          created_at: "2026-10-01T12:00:00Z",
          deleted_at: "2026-12-07T15:00:00Z",
          purge_after: later,
          purged_at: null,
          owner_confirmed_at: null,
        },
      ],
    });
    const account = await ok("at.happyproto.actor.getAccount", "customer");
    expect(account.deletedInstanceCount).toBe(1);
    expect(account.deletedInstances).toEqual([
      { id: GONE, slug: "cust-gone", deletedAt: "2026-12-07T15:00:00Z", purgeAfter: later },
    ]);
    expect(
      await ok("at.happyproto.server.deleteInstanceNow", "customer", {
        input: { id: GONE, idempotencyKey: crypto.randomUUID() },
      }),
    ).toEqual({ purging: true });
    expect((await ok("at.happyproto.actor.getAccount", "customer")).deletedInstances).toEqual([]);
    await fails("at.happyproto.server.deleteInstanceNow", "outsider", "Forbidden", {
      input: { id: GONE, idempotencyKey: crypto.randomUUID() },
    });
  });
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
