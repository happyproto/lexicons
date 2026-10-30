/**
 * server.listDeployments and server.getDeployment on a real HappyView v3,
 * against the fake provisioner.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const server = (name: string) => `at.happyproto.server.${name}`;

const MINE = "11111111-1111-4111-8111-111111111111";
const MY_OTHER = "22222222-2222-4222-8222-222222222222";
const THEIRS = "44444444-4444-4444-8444-444444444444";
const CREATE = "a0000000-0000-4000-8000-000000000001";
const UPGRADE = "a0000000-0000-4000-8000-000000000002";
const DOMAINS = "a0000000-0000-4000-8000-000000000003";
const OTHER_OP = "a0000000-0000-4000-8000-000000000004";
const THEIR_OP = "a0000000-0000-4000-8000-000000000005";

function tenant(id: string, slug: string, owner: string) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: "99999999-9999-4999-8999-999999999999",
    happyview_version: "3.0.0-alpha.41",
    public_url: `https://${slug}.happyview.app`,
    image: "ghcr.io/gamesgamesgamesgamesgames/happyview",
    routed: true,
    desired_state: "running",
    observed_state: "running",
    spec_hash: "sha256:abc",
    created_at: "2026-10-01T12:00:00Z",
    deleted_at: null,
    purge_after: null,
    purged_at: null,
    owner_confirmed_at: "2026-10-01T12:05:00Z",
  };
}

/** An operation row with every column the provisioner's Operation serialises. */
function op(id: string, tenantId: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: tenantId,
    kind: "create",
    status: "succeeded",
    params: {},
    steps: [
      { name: "apply", status: "succeeded", at: createdAt, detail: null },
      { name: "healthy", status: "succeeded", at: createdAt, detail: null },
    ],
    error_code: null,
    error_message: null,
    requested_by: "did:plc:placeholder",
    created_at: createdAt,
    started_at: createdAt,
    finished_at: createdAt,
    host_id: "99999999-9999-4999-8999-999999999999",
    ...extra,
  };
}

let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  const { customer, staff } = s.accounts;
  await provisioner.state({
    staff: [staff.did],
    tenants: [
      tenant(MINE, "alpha", customer.did),
      tenant(MY_OTHER, "beta", customer.did),
      tenant(THEIRS, "gamma", "did:plc:someoneelseentirely"),
    ],
    operations: [
      op(CREATE, MINE, "2026-10-01T12:00:00Z", { requested_by: customer.did }),
      op(UPGRADE, MINE, "2026-10-20T12:00:00Z", {
        kind: "upgrade",
        status: "failed",
        params: { version: { from: "3.0.0-alpha.40", to: "3.0.0-alpha.41" } },
        steps: [
          { name: "apply", status: "failed", at: "2026-10-20T12:00:05Z", detail: "the new release did not come up healthy" },
          { name: "rollback", status: "succeeded", at: "2026-10-20T12:00:30Z", detail: { restored: true, reason: "unhealthy" } },
        ],
        error_code: "UpgradeRolledBack",
        error_message: "apply: the new release did not come up healthy",
        requested_by: customer.did,
      }),
      op(DOMAINS, MINE, "2026-10-25T12:00:00Z", {
        kind: "update",
        params: { reason: "domains" },
        requested_by: staff.did,
      }),
      op(OTHER_OP, MY_OTHER, "2026-10-26T12:00:00Z", { requested_by: customer.did }),
      op(THEIR_OP, THEIRS, "2026-10-27T12:00:00Z", { requested_by: "did:plc:someoneelseentirely" }),
    ],
  });
});

describe("server.listDeployments", () => {
  test("lists the instance's changes newest first, mapped to the customer shape", async () => {
    const out = await ok(server("listDeployments"), "customer", { params: { id: MINE } });
    expect(out.deployments.map((d: any) => d.id)).toEqual([DOMAINS, UPGRADE, CREATE]);
    expect(out.cursor).toBeUndefined();
    expect(out.deployments[1]).toEqual({
      id: UPGRADE,
      kind: "upgrade",
      isDeployment: true,
      change: { version: { from: "3.0.0-alpha.40", to: "3.0.0-alpha.41" } },
      requestedBy: "owner",
      status: "failed",
      error: { code: "UpgradeRolledBack", message: "the new release did not come up healthy" },
      createdAt: "2026-10-20T12:00:00Z",
      startedAt: "2026-10-20T12:00:00Z",
      finishedAt: "2026-10-20T12:00:00Z",
    });
    // A domain change is history, not a deployment, and never names staff.
    expect(out.deployments[0]).toMatchObject({ isDeployment: false, requestedBy: "staff" });
    const text = JSON.stringify(out);
    for (const internal of ["host_id", "99999999", "requested_by", s.accounts.staff.did, "steps"]) {
      expect(text).not.toContain(internal);
    }
  });

  test("pages with a cursor", async () => {
    const first = await ok(server("listDeployments"), "customer", { params: { id: MINE, limit: "2" } });
    expect(first.deployments.map((d: any) => d.id)).toEqual([DOMAINS, UPGRADE]);
    expect(first.cursor).toBe(UPGRADE);
    const second = await ok(server("listDeployments"), "customer", {
      params: { id: MINE, limit: "2", cursor: first.cursor },
    });
    expect(second.deployments.map((d: any) => d.id)).toEqual([CREATE]);
    expect(second.cursor).toBeUndefined();
  });

  test("bad input is refused locally, and nothing is sent", async () => {
    for (const params of [{ id: "alpha" }, { id: MINE, cursor: "../x" }, { id: MINE, limit: "101" }, { id: MINE, limit: "0" }]) {
      await fails(server("listDeployments"), "customer", "InvalidRequest", { params });
    }
    expect(await provisioner.requests()).toEqual([]);
  });

  test("someone else's instance is NotFound, and its operations are never asked for", async () => {
    await fails(server("listDeployments"), "customer", "NotFound", { params: { id: THEIRS } });
    const asked = (await provisioner.requests()).map((r: any) => r.path);
    expect(asked.some((p: string) => p.includes("/operations"))).toBe(false);
  });

  test("outsiders are refused", async () => {
    await fails(server("listDeployments"), "outsider", "Forbidden", { params: { id: MINE } });
    await fails(server("listDeployments"), null, "AuthRequired", { params: { id: MINE } });
  });
});

describe("server.getDeployment", () => {
  test("returns the change with its steps, detail shown for an owner's code", async () => {
    const out = await ok(server("getDeployment"), "customer", { params: { id: MINE, deploymentId: UPGRADE } });
    expect(out.deployment.steps).toEqual([
      { name: "apply", status: "failed", at: "2026-10-20T12:00:05Z", detail: "the new release did not come up healthy" },
      { name: "rollback", status: "succeeded", at: "2026-10-20T12:00:30Z", detail: "unhealthy" },
    ]);
    expect(out.deployment).toMatchObject({ id: UPGRADE, kind: "upgrade", isDeployment: true });
  });

  test("a change of another instance is NotFound, even the caller's own", async () => {
    await fails(server("getDeployment"), "customer", "NotFound", { params: { id: MINE, deploymentId: OTHER_OP } });
    await fails(server("getDeployment"), "customer", "NotFound", { params: { id: MINE, deploymentId: THEIR_OP } });
    await fails(server("getDeployment"), "customer", "NotFound", {
      params: { id: MINE, deploymentId: "a0000000-0000-4000-8000-0000000000ff" },
    });
  });

  test("someone else's instance is NotFound", async () => {
    await fails(server("getDeployment"), "customer", "NotFound", { params: { id: THEIRS, deploymentId: THEIR_OP } });
  });

  test("bad ids are refused locally, and nothing is sent", async () => {
    await fails(server("getDeployment"), "customer", "InvalidRequest", { params: { id: MINE, deploymentId: "x" } });
    await fails(server("getDeployment"), "customer", "InvalidRequest", { params: { id: "x", deploymentId: UPGRADE } });
    expect(await provisioner.requests()).toEqual([]);
  });
});
