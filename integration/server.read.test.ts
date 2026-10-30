/**
 * The customer read endpoints -- plans, slugs, instances and the account --
 * on a real HappyView v3, against the fake provisioner.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { PROVISIONER_TOKEN, putMember, removeMember, setVariable, stack, type Stack } from "./setup";
import { call, fails, ok } from "./xrpc";

const server = (name: string) => `at.happyproto.server.${name}`;
const GET_ACCOUNT = "at.happyproto.actor.getAccount";

/** Fields the provisioner sends that a customer must never see. */
const INTERNAL = ["host_id", "image", "spec_hash", "routed", "owner_confirmed_at", "purge_after", "purged_at"];

const RUNNING_ID = "11111111-1111-4111-8111-111111111111";
const PROVISIONING_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_OWN_ID = "33333333-3333-4333-8333-333333333333";
const SOMEONE_ELSES_ID = "44444444-4444-4444-8444-444444444444";
const DELETED_ID = "77777777-7777-4777-8777-777777777777";
const CREATE_OP_ID = "55555555-5555-4555-8555-555555555555";

/** A tenant row with every column the provisioner's Tenant serialises. */
function tenant(id: string, slug: string, owner: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: "99999999-9999-4999-8999-999999999999",
    happyview_version: "3.0.0-alpha.3",
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
    ...extra,
  };
}

/** Every object key anywhere in `value`. */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keys(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keys(v, out);
    }
  }
  return out;
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
    instanceLimit: 3,
    tenants: [
      tenant(RUNNING_ID, "alpha", customer.did),
      tenant(PROVISIONING_ID, "beta", customer.did, {
        routed: false,
        observed_state: "absent",
        host_id: null,
        owner_confirmed_at: null,
      }),
      tenant(STAFF_OWN_ID, "staffs-own", staff.did),
      tenant(SOMEONE_ELSES_ID, "gamma", "did:plc:someoneelseentirely"),
      // Deleted but not yet purged: the provisioner still returns it by id.
      tenant(DELETED_ID, "delta", customer.did, {
        desired_state: "stopped",
        deleted_at: "2026-10-02T09:00:00Z",
        purge_after: "2026-11-01T09:00:00Z",
      }),
    ],
    operations: [
      {
        id: CREATE_OP_ID,
        tenant_id: PROVISIONING_ID,
        kind: "create",
        status: "pending",
        params: {},
        steps: [{ name: "pull_image", at: "2026-10-01T12:00:01Z" }],
        error_code: null,
        error_message: null,
        requested_by: customer.did,
        created_at: "2026-10-01T12:00:00Z",
        started_at: null,
        finished_at: null,
      },
    ],
  });
});

describe("outsiders are refused before anything reaches the provisioner", () => {
  const cases: [string, Record<string, string> | undefined][] = [
    ["listPlans", undefined],
    ["checkSlug", { slug: "fresh-slug" }],
    ["listInstances", undefined],
    ["getInstance", { id: RUNNING_ID }],
  ];
  for (const [name, params] of cases) {
    test(name, async () => {
      await fails(server(name), "outsider", "Forbidden", { params });
      await fails(server(name), null, "AuthRequired", { params });
      // Staff are not customers either, until they are added.
      await fails(server(name), "staff", "Forbidden", { params });
      expect(await provisioner.requests()).toEqual([]);
    });
  }
});

describe("server.listPlans", () => {
  test("maps the provisioner's plans", async () => {
    const out = await ok(server("listPlans"), "customer");
    expect(out).toEqual({
      plans: [
        { id: "small", name: "Small", memoryMb: 512, cpuMillis: 500, diskGb: 5 },
        { id: "medium", name: "Medium", memoryMb: 1024, cpuMillis: 1000, diskGb: 10 },
      ],
    });
  });

  test("no plans is an empty array, not an object", async () => {
    await provisioner.state({ plans: [] });
    expect(await ok(server("listPlans"), "customer")).toEqual({ plans: [] });
  });

  test("Review Focus 4: a 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("GET", "/v1/plans", 503, { error: "Boom", message: "SENTINEL-123" });
    const reply = await fails(server("listPlans"), "customer", "Upstream");
    expect(reply.text).not.toContain("SENTINEL-123");
    expect(reply.text).not.toContain("Boom");
  });

  test("a code the provisioner chose to say passes through with its message", async () => {
    await provisioner.script("GET", "/v1/plans", 403, { error: "Forbidden", message: "not today" });
    const reply = await fails(server("listPlans"), "customer", "Forbidden");
    expect(reply.body.message).toBe("not today");
  });

  describe("Review Focus 3: a missing script variable fails closed", () => {
    afterEach(async () => {
      for (const key of ["HAPPYPROTO_DID", "PROVISIONER_URL", "PROVISIONER_TOKEN"]) {
        await setVariable(s.apiKey, key, s.variables[key]);
      }
    });

    test("no HAPPYPROTO_DID, or one that is not a DID: Forbidden, and nothing is sent", async () => {
      for (const value of ["", "happyproto"]) {
        await setVariable(s.apiKey, "HAPPYPROTO_DID", value);
        await fails(server("listPlans"), "customer", "Forbidden");
      }
      expect(await provisioner.requests()).toEqual([]);
    });

    test("no provisioner URL or token: a legible Upstream, and nothing is sent", async () => {
      await setVariable(s.apiKey, "PROVISIONER_URL", "");
      await fails(server("listPlans"), "customer", "Upstream");
      await setVariable(s.apiKey, "PROVISIONER_URL", s.variables.PROVISIONER_URL);
      await setVariable(s.apiKey, "PROVISIONER_TOKEN", "");
      await fails(server("listPlans"), "customer", "Upstream");
      expect(await provisioner.requests()).toEqual([]);
    });
  });
});

describe("server.checkSlug", () => {
  test("a free slug is available", async () => {
    expect(await ok(server("checkSlug"), "customer", { params: { slug: "fresh-slug" } })).toEqual({
      available: true,
    });
    const [request] = await provisioner.requests();
    expect(request.path).toBe("/v1/slugs/fresh-slug");
  });

  test("a held slug is taken", async () => {
    expect(await ok(server("checkSlug"), "customer", { params: { slug: "alpha" } })).toEqual({
      available: false,
      reason: "taken",
    });
  });

  test("an invalid slug is answered locally", async () => {
    expect(await ok(server("checkSlug"), "customer", { params: { slug: "Bad Slug" } })).toEqual({
      available: false,
      reason: "invalid",
    });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("no slug is InvalidRequest, and nothing is sent", async () => {
    await fails(server("checkSlug"), "customer", "InvalidRequest");
    await fails(server("checkSlug"), "customer", "InvalidRequest", { params: { slug: "" } });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("a reserved slug is answered locally", async () => {
    expect(await ok(server("checkSlug"), "customer", { params: { slug: "www" } })).toEqual({
      available: false,
      reason: "reserved",
    });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("a 5xx is Upstream", async () => {
    await provisioner.script("GET", "/v1/slugs/fresh-slug", 500, { error: "Internal", message: "SENTINEL-456" });
    const reply = await fails(server("checkSlug"), "customer", "Upstream", {
      params: { slug: "fresh-slug" },
    });
    expect(reply.text).not.toContain("SENTINEL-456");
  });
});

describe("server.listInstances", () => {
  test("lists the caller's own instances, with state derived and internals left out", async () => {
    const out = await ok(server("listInstances"), "customer");
    expect(out.instances).toEqual([
      {
        id: RUNNING_ID,
        slug: "alpha",
        url: "https://alpha.happyview.app",
        plan: "small",
        version: "3.0.0-alpha.3",
        state: "running",
        createdAt: "2026-10-01T12:00:00Z",
      },
      {
        id: PROVISIONING_ID,
        slug: "beta",
        url: "https://beta.happyview.app",
        plan: "small",
        version: "3.0.0-alpha.3",
        state: "provisioning",
        createdAt: "2026-10-01T12:00:00Z",
        operation: { id: CREATE_OP_ID, kind: "create", status: "pending", step: "pull_image" },
      },
    ]);
    const seen = keys(out);
    for (const field of [...INTERNAL, "owner_did"]) expect(seen.has(field)).toBe(false);
  });

  test("always asks for the caller's own, by owner_did", async () => {
    await ok(server("listInstances"), "customer");
    const [request] = await provisioner.requests();
    expect(request.path).toBe("/v1/tenants");
    expect(request.query).toEqual({ owner_did: s.accounts.customer.did });
  });

  test("no instances is an empty array, not an object", async () => {
    await provisioner.state({ tenants: [], operations: [] });
    expect(await ok(server("listInstances"), "customer")).toEqual({ instances: [] });
  });
});

describe("server.getInstance", () => {
  test("returns the caller's instance", async () => {
    const out = await ok(server("getInstance"), "customer", { params: { id: PROVISIONING_ID } });
    expect(out).toEqual({
      instance: {
        id: PROVISIONING_ID,
        slug: "beta",
        url: "https://beta.happyview.app",
        plan: "small",
        version: "3.0.0-alpha.3",
        state: "provisioning",
        createdAt: "2026-10-01T12:00:00Z",
        // The full operation, as GET /v1/tenants/:id sends it, mapped down.
        operation: { id: CREATE_OP_ID, kind: "create", status: "pending", step: "pull_image" },
      },
    });
    const seen = keys(out);
    for (const field of [...INTERNAL, "owner_did", "requested_by", "params", "steps"]) {
      expect(seen.has(field)).toBe(false);
    }
  });

  test("a non-UUID id is InvalidRequest, and nothing is sent", async () => {
    await fails(server("getInstance"), "customer", "InvalidRequest", { params: { id: "../plans" } });
    await fails(server("getInstance"), "customer", "InvalidRequest", { params: { id: "alpha" } });
    await fails(server("getInstance"), "customer", "InvalidRequest");
    expect(await provisioner.requests()).toEqual([]);
  });

  test("someone else's instance, or none at all, is NotFound", async () => {
    await fails(server("getInstance"), "customer", "NotFound", { params: { id: SOMEONE_ELSES_ID } });
    await fails(server("getInstance"), "customer", "NotFound", {
      params: { id: "66666666-6666-4666-8666-666666666666" },
    });
  });
});

describe("deleted instances", () => {
  test("are not listed", async () => {
    const out = await ok(server("listInstances"), "customer");
    expect(out.instances.map((i: { id: string }) => i.id)).not.toContain(DELETED_ID);
  });

  test("are NotFound by id, though the provisioner still returns them", async () => {
    const reply = await fails(server("getInstance"), "customer", "NotFound", {
      params: { id: DELETED_ID },
    });
    // The same words as any other missing instance.
    expect(reply.body.message).toBe("instance not found");
    const [request] = await provisioner.requests();
    expect(request.path).toBe(`/v1/tenants/${DELETED_ID}`);
  });
});

describe("staff using the customer endpoints see only their own", () => {
  beforeEach(async () => {
    await putMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.staff.did);
  });
  afterEach(async () => {
    await removeMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.staff.did);
  });

  test("listInstances asks for and returns only the caller's", async () => {
    const out = await ok(server("listInstances"), "staff");
    expect(out.instances.map((i: { id: string }) => i.id)).toEqual([STAFF_OWN_ID]);
    const [request] = await provisioner.requests();
    expect(request.query).toEqual({ owner_did: s.accounts.staff.did });
  });

  test("getInstance refuses another owner's instance even though the provisioner returned it", async () => {
    await fails(server("getInstance"), "staff", "NotFound", { params: { id: SOMEONE_ELSES_ID } });
    // The provisioner did answer: staff may read any tenant there.
    const [request] = await provisioner.requests();
    expect(request.path).toBe(`/v1/tenants/${SOMEONE_ELSES_ID}`);
    expect(await ok(server("getInstance"), "staff", { params: { id: STAFF_OWN_ID } })).toMatchObject({
      instance: { id: STAFF_OWN_ID },
    });
  });
});

describe("server.getUsage", () => {
  const usagePath = `/v1/tenants/${RUNNING_ID}/usage`;

  test("reads the caller's own instance's usage, in the shared shape", async () => {
    await provisioner.script("GET", usagePath, 200, {
      tenant: RUNNING_ID,
      grain: "day",
      rows: [
        {
          day: "2026-10-26",
          running_seconds: 86400,
          cpu_usec: 1,
          mem_byte_seconds: 2,
          mem_peak_bytes: 3,
          egress_bytes: 4,
          ingress_bytes: 5,
          disk_avg_bytes: 8,
          disk_peak_bytes: null,
          seats: 2,
          api_clients: null,
          partial: true,
          extra: "never passed on",
        },
      ],
      gaps: [{ hour: "2026-10-26T03:00:00Z", reason: "agent_unreachable" }],
    });
    const out = await ok(server("getUsage"), "customer", {
      params: { id: RUNNING_ID, grain: "day", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" },
    });
    expect(out).toEqual({
      tenant: RUNNING_ID,
      grain: "day",
      rows: [
        {
          day: "2026-10-26",
          runningSeconds: 86400,
          cpuUsec: 1,
          memByteSeconds: 2,
          memPeakBytes: 3,
          egressBytes: 4,
          ingressBytes: 5,
          diskAvgBytes: 8,
          seats: 2,
          partial: true,
        },
      ],
      gaps: [{ hour: "2026-10-26T03:00:00Z", reason: "agent_unreachable" }],
    });
    const sent = (await provisioner.requests()).filter((r) => r.path === usagePath);
    expect(sent).toHaveLength(1);
    expect(sent[0].query).toEqual({ grain: "day", from: "2026-10-01T00:00:00Z", to: "2026-10-31T00:00:00Z" });
    expect(sent[0].headers["x-actor-did"]).toBe(s.accounts.customer.did);
  });

  test("someone else's instance is NotFound, and their usage is never read", async () => {
    await fails(server("getUsage"), "customer", "NotFound", { params: { id: SOMEONE_ELSES_ID } });
    const reads = (await provisioner.requests()).filter((r) => r.path.endsWith("/usage"));
    expect(reads).toEqual([]);
  });

  test("a bad id or range is InvalidRequest", async () => {
    await fails(server("getUsage"), "customer", "InvalidRequest", { params: { id: "../plans" } });
    await fails(server("getUsage"), "customer", "InvalidRequest", { params: { id: RUNNING_ID, grain: "week" } });
  });

  test("is Forbidden to non-customers", async () => {
    await fails(server("getUsage"), "outsider", "Forbidden", { params: { id: RUNNING_ID } });
  });
});

describe("actor.getAccount", () => {
  test("a customer gets their count and limit from the provisioner", async () => {
    expect(await ok(GET_ACCOUNT, "customer")).toEqual({
      isCustomer: true,
      instanceCount: 2,
      instanceLimit: 3,
    });
    const [request] = await provisioner.requests();
    expect(request.path).toBe("/v1/account");
  });

  test("anyone else gets zeros, without a provisioner call", async () => {
    expect(await ok(GET_ACCOUNT, "outsider")).toEqual({
      isCustomer: false,
      instanceCount: 0,
      instanceLimit: 0,
    });
    expect(await ok(GET_ACCOUNT, "staff")).toEqual({
      isCustomer: false,
      instanceCount: 0,
      instanceLimit: 0,
    });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("anonymous callers are refused", async () => {
    await fails(GET_ACCOUNT, null, "AuthRequired");
  });

  test("a provisioner failure is Upstream", async () => {
    await provisioner.script("GET", "/v1/account", 502, { error: "Bad", message: "SENTINEL-789" });
    const reply = await fails(GET_ACCOUNT, "customer", "Upstream");
    expect(reply.text).not.toContain("SENTINEL-789");
  });
});

test("every request reaching the provisioner carries the caller and the token", async () => {
  await ok(server("listPlans"), "customer");
  await ok(server("checkSlug"), "customer", { params: { slug: "fresh-slug" } });
  await ok(server("listInstances"), "customer");
  await ok(server("getInstance"), "customer", { params: { id: RUNNING_ID } });
  await ok(GET_ACCOUNT, "customer");

  const requests = await provisioner.requests();
  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    "GET /v1/plans",
    "GET /v1/slugs/fresh-slug",
    "GET /v1/tenants",
    `GET /v1/tenants/${RUNNING_ID}`,
    "GET /v1/account",
  ]);
  for (const r of requests) {
    expect(r.headers["x-actor-did"]).toBe(s.accounts.customer.did);
    expect(r.headers.authorization).toBe(`Bearer ${PROVISIONER_TOKEN}`);
    // Reads are never idempotent writes.
    expect(r.headers["idempotency-key"]).toBeUndefined();
  }
});
