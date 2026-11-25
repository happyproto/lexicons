/**
 * Staff account levers -- admin.getAccount, admin.suspendAccount and
 * admin.unsuspendAccount -- on a real HappyView v3 against the fake
 * provisioner (HAP-511). Staff only: a customer and an outsider are refused.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const admin = (name: string) => `at.happyproto.admin.${name}`;
const key = () => crypto.randomUUID();
const RUNNING = "11111111-1111-4111-8111-111111111111";
const STOPPED = "22222222-2222-4222-8222-222222222222";

let s: Stack;

function tenant(id: string, slug: string, owner: string, desired: string) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: null,
    happyview_version: "3.0.0-alpha.4",
    public_url: `https://${slug}.happyview.app`,
    image: "ghcr.io/gamesgamesgamesgamesgames/happyview",
    routed: true,
    desired_state: desired,
    observed_state: desired,
    spec_hash: "sha256:abc",
    created_at: "2026-10-01T12:00:00Z",
    deleted_at: null,
    purge_after: null,
    purged_at: null,
    owner_confirmed_at: "2026-10-01T12:05:00Z",
  };
}

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  const owner = s.accounts.customer.did;
  await provisioner.state({
    staff: [s.accounts.staff.did],
    tenants: [tenant(RUNNING, "cust-run", owner, "running"), tenant(STOPPED, "cust-stop", owner, "stopped")],
  });
});

describe("account suspension", () => {
  test("staff suspend an account, see it, and lift it", async () => {
    const did = s.accounts.customer.did;
    const suspended = await ok(admin("suspendAccount"), "staff", {
      input: { did, reason: "  spam instances ", idempotencyKey: key() },
    });
    expect(suspended).toEqual({ stopped: 1 });

    const [asked] = (await provisioner.requests()).filter((r: { path: string }) => r.path.endsWith("/suspend"));
    expect(asked.path).toBe(`/v1/admin/accounts/${encodeURIComponent(did)}/suspend`);
    expect(asked.body).toEqual({ reason: "spam instances" });

    const account = await ok(admin("getAccount"), "staff", { params: { did } });
    expect(account).toMatchObject({ did, cohort: "closed_beta", instanceCount: 2 });
    expect(account.suspension.reason).toBe("spam instances");

    expect(await ok(admin("unsuspendAccount"), "staff", { input: { did, idempotencyKey: key() } })).toEqual({
      started: 1,
    });
    expect((await ok(admin("getAccount"), "staff", { params: { did } })).suspension).toBeUndefined();
  });

  test("an unknown account is NotFound, and can't be suspended", async () => {
    await fails(admin("getAccount"), "staff", "NotFound", { params: { did: "did:plc:nobodyatallhere" } });
    await fails(admin("suspendAccount"), "staff", "NotFound", {
      input: { did: "did:plc:nobodyatallhere", reason: "spam", idempotencyKey: key() },
    });
  });

  test("a reason is required", async () => {
    await fails(admin("suspendAccount"), "staff", "InvalidRequest", {
      input: { did: s.accounts.customer.did, reason: "   ", idempotencyKey: key() },
    });
  });

  test("is staff only", async () => {
    for (const who of ["customer", "outsider"] as const) {
      await fails(admin("getAccount"), who, "Forbidden", { params: { did: s.accounts.customer.did } });
      await fails(admin("suspendAccount"), who, "Forbidden", {
        input: { did: s.accounts.customer.did, reason: "x", idempotencyKey: key() },
      });
      await fails(admin("unsuspendAccount"), who, "Forbidden", {
        input: { did: s.accounts.customer.did, idempotencyKey: key() },
      });
    }
  });
});
