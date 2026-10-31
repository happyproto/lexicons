/**
 * The staff endpoints -- every instance, host and job, and the customers
 * space's membership -- on a real HappyView v3 against the fake provisioner.
 *
 * Staff see everything here, and nobody else sees anything: each endpoint is
 * Forbidden to a customer and to an outsider.
 *
 * Changing the customers space's members is a spaces write, which HappyView
 * runs as the caller and allows only to the space's creator or a HappyView
 * super user. `staff` is made a super user for this file, as a staff member
 * on api.happyproto.at must be, and one test shows what happens when they
 * are not.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner, TERMS } from "./fakes";
import { ensureTestUser } from "./session";
import { PROVISIONER_TOKEN, removeMember, setVariable, stack, type Stack } from "./setup";
import { call, fails, ok } from "./xrpc";

const admin = (name: string) => `at.happyproto.admin.${name}`;
const server = (name: string) => `at.happyproto.server.${name}`;

const HOST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_HOST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const UNPLACED_ID = "66666666-6666-4666-8666-666666666666";
const ORPHAN_ID = "77777777-7777-4777-8777-777777777777";
const CREATE_OP_ID = "55555555-5555-4555-8555-555555555555";
const SOMEONE = "did:plc:someoneelseentirely";

const JOB_TIMEOUT = 90_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "paused"]);
const SESSION_FIELDS = ["inherit_auth", "api_client_id", "dpop_key_id"];

/** A tenant row with every column the provisioner's Tenant serialises. */
function tenant(id: string, slug: string, owner: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: HOST_A,
    happyview_version: "3.0.0-alpha.4",
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

/** A host row with every column the provisioner's Host serialises. */
function host(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    private_addr: "10.0.0.5",
    public_ipv4: "203.0.113.5",
    public_ipv6: null,
    memory_mb: 16384,
    cpu_millis: 8000,
    disk_gb: 200,
    state: "active",
    agent_cert_fingerprint: "f".repeat(64),
    last_seen_at: "2026-10-08T09:00:00Z",
    failed_contacts: 0,
    created_at: "2026-09-01T00:00:00Z",
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

/** Seed the fake with two hosts and four tenants, staff in its STAFF_DIDS. */
async function seed(staff = true): Promise<void> {
  await provisioner.reset();
  await provisioner.state({
    staff: staff ? [s.accounts.staff.did] : [],
    instanceLimit: 10,
    hosts: [host(HOST_B, "host-b", { state: "draining", last_seen_at: null }), host(HOST_A, "host-a")],
    tenants: [
      tenant(CUSTOMER_ID, "alpha", s.accounts.customer.did),
      tenant(OTHER_ID, "gamma", SOMEONE, { plan_id: "medium", host_id: HOST_B, routed: false }),
      tenant(UNPLACED_ID, "nowhere", SOMEONE, {
        host_id: null,
        routed: false,
        observed_state: "pending",
        owner_confirmed_at: null,
      }),
      tenant(ORPHAN_ID, "orphan", SOMEONE, { host_id: MISSING_HOST, desired_state: "stopped", observed_state: "stopped" }),
    ],
    operations: [
      {
        id: CREATE_OP_ID,
        tenant_id: UNPLACED_ID,
        kind: "create",
        status: "running",
        params: {},
        steps: [{ name: "pull_image", at: "2026-10-01T12:00:02Z" }],
        error_code: null,
        error_message: null,
        requested_by: SOMEONE,
        created_at: "2026-10-01T12:00:00Z",
        started_at: "2026-10-01T12:00:01Z",
        finished_at: null,
      },
    ],
  });
}

const customersOf = async (): Promise<string[]> =>
  (await ok(admin("listCustomers"), "staff")).customers.map((c: { did: string }) => c.did);

beforeAll(async () => {
  s = await stack();
  await ensureTestUser(s.accounts.staff.did, true);
}, 180_000);

beforeEach(() => seed());

afterAll(async () => {
  // Leave the outsider as every other file expects: not a customer.
  try {
    await removeMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.outsider.did);
  } catch {
    // Already not a member.
  }
}, 30_000);

describe("refusals", () => {
  const calls: [string, { params?: Record<string, string>; input?: unknown }][] = [
    ["listInstances", {}],
    ["listHosts", {}],
    ["listJobs", {}],
    ["listCustomers", {}],
    ["addCustomer", { input: { did: SOMEONE } }],
    ["removeCustomer", { input: { did: SOMEONE } }],
  ];
  for (const [name, options] of calls) {
    test(`${name} is Forbidden to a customer and an outsider, and sends nothing`, async () => {
      const before = await customersOf();
      await fails(admin(name), "customer", "Forbidden", options);
      await fails(admin(name), "outsider", "Forbidden", options);
      expect(await provisioner.requests()).toEqual([]);
      expect(await customersOf()).toEqual(before);
    });
  }

  test("a query with no caller is AuthRequired", async () => {
    await fails(admin("listInstances"), null, "AuthRequired");
    await fails(admin("listJobs"), null, "AuthRequired");
  });
});

describe("admin.listHosts", () => {
  test("every host, in camelCase, with its usage and nothing private", async () => {
    const { hosts, unplaceablePlans } = await ok(admin("listHosts"), "staff");
    expect(unplaceablePlans).toEqual([]);
    expect(hosts).toEqual([
      {
        id: HOST_A,
        name: "host-a",
        state: "active",
        memoryMb: 16384,
        cpuMillis: 8000,
        diskGb: 200,
        // alpha only: orphan names a host the list does not have.
        tenantCount: 1,
        reservedMemoryMb: 512,
        reservedDiskGb: 5,
        freeMemoryMb: 15872,
        freeDiskGb: 195,
        placeablePlans: ["small", "medium"],
        lastSeenAt: "2026-10-08T09:00:00Z",
      },
      {
        id: HOST_B,
        name: "host-b",
        state: "draining",
        memoryMb: 16384,
        cpuMillis: 8000,
        diskGb: 200,
        tenantCount: 1,
        reservedMemoryMb: 1024,
        reservedDiskGb: 10,
        freeMemoryMb: 15360,
        freeDiskGb: 190,
        // Draining: nothing new is placed here, whatever it has free.
        placeablePlans: [],
      },
    ]);
    for (const field of ["private_addr", "public_ipv4", "agent_cert_fingerprint", "failed_contacts"]) {
      expect(keys(hosts).has(field)).toBe(false);
    }

    const [request, ...rest] = await provisioner.requests();
    expect(rest).toEqual([]);
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/hosts");
    expect(request.headers["x-actor-did"]).toBe(s.accounts.staff.did);
    expect(request.headers.authorization).toBe(`Bearer ${PROVISIONER_TOKEN}`);
  });

  test("no hosts is an empty list, and no plan can be placed", async () => {
    await provisioner.state({ hosts: [] });
    expect(await ok(admin("listHosts"), "staff")).toEqual({ hosts: [], unplaceablePlans: ["small", "medium"] });
  });

  test("a full host lists what no longer fits, and a deleted instance still holds its disk", async () => {
    await provisioner.state({
      hosts: [host(HOST_A, "host-a", { memory_mb: 1024, disk_gb: 12 })],
      tenants: [
        tenant(CUSTOMER_ID, "alpha", s.accounts.customer.did),
        // Deleted, not yet purged: its memory is free again, its disk is not.
        tenant(OTHER_ID, "gamma", SOMEONE, { plan_id: "medium", deleted_at: "2026-10-28T00:00:00Z" }),
      ],
    });
    const { hosts, unplaceablePlans } = await ok(admin("listHosts"), "staff");
    expect(hosts[0]).toMatchObject({
      tenantCount: 1,
      reservedMemoryMb: 512,
      reservedDiskGb: 15,
      freeMemoryMb: 512,
      // Over-committed: more is reserved than the host has.
      freeDiskGb: -3,
      placeablePlans: [],
    });
    expect(unplaceablePlans).toEqual(["small", "medium"]);
  });

  test("a provisioner that reports no capacity leaves it absent", async () => {
    await provisioner.script("GET", "/v1/hosts", 200, {
      hosts: [
        {
          id: HOST_A,
          name: "host-a",
          state: "active",
          memory_mb: 16384,
          cpu_millis: 8000,
          disk_gb: 200,
          tenant_count: 0,
          reserved_memory_mb: 0,
          reserved_disk_gb: 0,
          last_seen_at: null,
        },
      ],
    });
    const body = await ok(admin("listHosts"), "staff");
    expect(body).toEqual({
      hosts: [
        {
          id: HOST_A,
          name: "host-a",
          state: "active",
          memoryMb: 16384,
          cpuMillis: 8000,
          diskGb: 200,
          tenantCount: 0,
          reservedMemoryMb: 0,
          reservedDiskGb: 0,
        },
      ],
    });
  });

  test("a 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("GET", "/v1/hosts", 503, { error: "Internal", message: "SENTINEL-hosts" });
    const reply = await fails(admin("listHosts"), "staff", "Upstream");
    expect(reply.text).not.toContain("SENTINEL");
  });
});

describe("admin.listInstances", () => {
  test("every owner's instances, with hostName joined from the hosts list", async () => {
    const { instances } = await ok(admin("listInstances"), "staff");
    const byId = Object.fromEntries(instances.map((i: { id: string }) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual([CUSTOMER_ID, OTHER_ID, UNPLACED_ID, ORPHAN_ID].sort());

    expect(byId[CUSTOMER_ID]).toEqual({
      id: CUSTOMER_ID,
      slug: "alpha",
      url: "https://alpha.happyview.app",
      plan: "small",
      version: "3.0.0-alpha.4",
      state: "running",
      createdAt: "2026-10-01T12:00:00Z",
      ownerDid: s.accounts.customer.did,
      hostId: HOST_A,
      hostName: "host-a",
      desiredState: "running",
      observedState: "running",
      routed: true,
    });
    expect(byId[OTHER_ID]).toMatchObject({ ownerDid: SOMEONE, hostId: HOST_B, hostName: "host-b", routed: false });
    // Not yet placed: no host at all, and its operation shows.
    expect(byId[UNPLACED_ID]).toMatchObject({
      state: "provisioning",
      observedState: "pending",
      operation: { id: CREATE_OP_ID, kind: "create", status: "running", step: "pull_image" },
    });
    expect("hostId" in byId[UNPLACED_ID]).toBe(false);
    expect("hostName" in byId[UNPLACED_ID]).toBe(false);
    // Placed on a host the list does not have: its id, and no name.
    expect(byId[ORPHAN_ID]).toMatchObject({ hostId: MISSING_HOST, state: "stopped" });
    expect("hostName" in byId[ORPHAN_ID]).toBe(false);

    for (const field of ["image", "spec_hash", "owner_confirmed_at", "purge_after", "purged_at", "host_id"]) {
      expect(keys(instances).has(field)).toBe(false);
    }

    const requests = await provisioner.requests();
    expect(requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /v1/hosts", "GET /v1/tenants"]);
    const list = requests.find((r) => r.path === "/v1/tenants")!;
    // No owner_did: for staff, that is every tenant.
    expect(list.query).toEqual({});
    for (const r of requests) expect(r.headers["x-actor-did"]).toBe(s.accounts.staff.did);
  });

  test("owner narrows the list, and is sent URL-encoded", async () => {
    const { instances } = await ok(admin("listInstances"), "staff", { params: { owner: SOMEONE } });
    expect(instances.map((i: { id: string }) => i.id).sort()).toEqual([OTHER_ID, UNPLACED_ID, ORPHAN_ID].sort());
    const list = (await provisioner.requests()).find((r) => r.path === "/v1/tenants")!;
    expect(list.query).toEqual({ owner_did: SOMEONE });

    await seed();
    const web = "did:web:example.com%3A8443";
    await ok(admin("listInstances"), "staff", { params: { owner: web } });
    const encoded = (await provisioner.requests()).find((r) => r.path === "/v1/tenants")!;
    expect(encoded.query).toEqual({ owner_did: web });
  });

  test("an owner that is not a DID is InvalidRequest, and nothing is sent", async () => {
    await fails(admin("listInstances"), "staff", "InvalidRequest", { params: { owner: "alice" } });
    await fails(admin("listInstances"), "staff", "InvalidRequest", { params: { owner: "did:plc:x&owner_did=y" } });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("Review Focus 5: staff the provisioner does not know get its Forbidden", async () => {
    // The fake's own answer: staff is not in its STAFF_DIDS, so GET /v1/hosts
    // is 403 "staff only" -- and GET /v1/tenants would quietly answer with
    // only their own tenants, which must not pass for the whole fleet.
    await seed(false);
    const reply = await fails(admin("listInstances"), "staff", "Forbidden");
    expect(reply.body).toEqual({ error: "Forbidden", message: "staff only" });
    await fails(admin("listHosts"), "staff", "Forbidden");
  });

  test("Review Focus 5: a scripted 403 on a staff route is Forbidden", async () => {
    await provisioner.script("GET", "/v1/hosts", 403, { error: "Forbidden", message: "staff only" });
    const reply = await fails(admin("listInstances"), "staff", "Forbidden");
    expect(reply.body.error).toBe("Forbidden");

    await provisioner.script("GET", "/v1/tenants", 403, { error: "Forbidden", message: "staff only" });
    await fails(admin("listInstances"), "staff", "Forbidden");
  });

  test("a 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("GET", "/v1/tenants", 500, { error: "Internal", message: "SENTINEL-tenants" });
    const reply = await fails(admin("listInstances"), "staff", "Upstream");
    expect(reply.text).not.toContain("SENTINEL");
  });
});

describe("customers", () => {
  afterEach(async () => {
    await ensureTestUser(s.accounts.staff.did, true);
    try {
      await removeMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.outsider.did);
    } catch {
      // Already not a member.
    }
  });

  test("listCustomers lists the customers space's members", async () => {
    const { customers } = await ok(admin("listCustomers"), "staff");
    const dids = customers.map((c: { did: string }) => c.did);
    expect(dids).toContain(s.accounts.customer.did);
    expect(dids).not.toContain(s.accounts.outsider.did);
    expect(dids).not.toContain(s.accounts.staff.did);
    for (const c of customers) expect(Object.keys(c).every((k) => k === "did" || k === "handle")).toBe(true);
  });

  test("addCustomer lets the outsider in, and removeCustomer shuts them out", async () => {
    const { outsider } = s.accounts;
    await fails(server("listPlans"), "outsider", "Forbidden");

    expect(await ok(admin("addCustomer"), "staff", { input: { did: outsider.did } })).toEqual({});
    await ok(server("listPlans"), "outsider");
    expect(await customersOf()).toContain(outsider.did);

    expect(await ok(admin("removeCustomer"), "staff", { input: { did: outsider.did } })).toEqual({});
    await fails(server("listPlans"), "outsider", "Forbidden");
    expect(await customersOf()).not.toContain(outsider.did);
  });

  test("adding twice and removing twice both succeed", async () => {
    const did = s.accounts.outsider.did;
    await ok(admin("addCustomer"), "staff", { input: { did } });
    await ok(admin("addCustomer"), "staff", { input: { did } });
    await ok(server("listPlans"), "outsider");
    await ok(admin("removeCustomer"), "staff", { input: { did } });
    await ok(admin("removeCustomer"), "staff", { input: { did } });
    await fails(server("listPlans"), "outsider", "Forbidden");
  });

  test("a DID that is not one is InvalidRequest, and nothing changes", async () => {
    const before = await customersOf();
    for (const did of ["alice", "", "did:plc:", undefined]) {
      await fails(admin("addCustomer"), "staff", "InvalidRequest", { input: { did } });
      await fails(admin("removeCustomer"), "staff", "InvalidRequest", { input: { did } });
    }
    expect(await customersOf()).toEqual(before);
  });

  test("no HAPPYPROTO_DID: the gate refuses, and nothing changes", async () => {
    try {
      await setVariable(s.apiKey, "HAPPYPROTO_DID", "");
      const did = s.accounts.outsider.did;
      for (const name of ["addCustomer", "removeCustomer"]) {
        await fails(admin(name), "staff", "Forbidden", { input: { did } });
      }
      await fails(admin("listCustomers"), "staff", "Forbidden");
    } finally {
      await setVariable(s.apiKey, "HAPPYPROTO_DID", s.variables.HAPPYPROTO_DID);
    }
    expect(await customersOf()).not.toContain(s.accounts.outsider.did);
  });

  test("staff who may not change the space are Forbidden, saying why", async () => {
    await ensureTestUser(s.accounts.staff.did, false);
    const did = s.accounts.outsider.did;
    const added = await fails(admin("addCustomer"), "staff", "Forbidden", { input: { did } });
    expect(added.body.message).toContain("super user");
    await fails(admin("removeCustomer"), "staff", "Forbidden", { input: { did: s.accounts.customer.did } });
    expect(await customersOf()).toContain(s.accounts.customer.did);
    expect(await customersOf()).not.toContain(did);
  });
});

describe("admin.listJobs", () => {
  /** Wait for a job to end, read through listJobs as staff. */
  async function untilDone(id: string): Promise<any> {
    const deadline = Date.now() + JOB_TIMEOUT - 5_000;
    while (Date.now() < deadline) {
      const { jobs } = await ok(admin("listJobs"), "staff", {
        params: { status: "pending,running,pausing,cancelling,paused,completed,failed,cancelled", limit: 200 },
      });
      const job = jobs.find((j: { id: string }) => j.id === id);
      if (job && TERMINAL.has(job.status)) return job;
      await Bun.sleep(250);
    }
    throw new Error(`job ${id} did not finish`);
  }

  let customerJob: string;
  let outsiderJob: string;

  beforeAll(async () => {
    await seed();
    await ok(admin("addCustomer"), "staff", { input: { did: s.accounts.outsider.did } });
    try {
      customerJob = (
        await ok(server("createInstance"), "customer", {
          input: { slug: "staff-sees", plan: "small", terms: TERMS, idempotencyKey: crypto.randomUUID() },
        })
      ).jobId;
      outsiderJob = (
        await ok(server("createInstance"), "outsider", {
          input: { slug: "also-seen", plan: "small", terms: TERMS, idempotencyKey: crypto.randomUUID() },
        })
      ).jobId;
      await untilDone(customerJob);
      await untilDone(outsiderJob);
    } finally {
      await ok(admin("removeCustomer"), "staff", { input: { did: s.accounts.outsider.did } });
    }
  }, JOB_TIMEOUT * 2);

  test("finished jobs from both customers, with their creators and no session fields", async () => {
    const { jobs } = await ok(admin("listJobs"), "staff", {
      params: { status: "completed", jobType: "instance.operation", limit: 200 },
    });
    const byId = Object.fromEntries(jobs.map((j: { id: string }) => [j.id, j]));
    expect(byId[customerJob]).toMatchObject({
      id: customerJob,
      status: "completed",
      jobType: "instance.operation",
      createdBy: s.accounts.customer.did,
      result: { status: "succeeded" },
    });
    expect(byId[outsiderJob]).toMatchObject({
      id: outsiderJob,
      status: "completed",
      jobType: "instance.operation",
      createdBy: s.accounts.outsider.did,
    });
    for (const job of [byId[customerJob], byId[outsiderJob]]) {
      expect(typeof job.createdAt).toBe("string");
      expect(typeof job.startedAt).toBe("string");
      expect(typeof job.completedAt).toBe("string");
    }
    const seen = keys(jobs);
    for (const field of [...SESSION_FIELDS, "input", "job_type", "created_by", "created_at"]) {
      expect(seen.has(field)).toBe(false);
    }
    for (const job of jobs) {
      expect(job.status).toBe("completed");
      expect(job.jobType).toBe("instance.operation");
    }
  });

  test("with no params: only active jobs, so the finished ones are absent", async () => {
    const { jobs } = await ok(admin("listJobs"), "staff");
    const ids = jobs.map((j: { id: string }) => j.id);
    expect(ids).not.toContain(customerJob);
    expect(ids).not.toContain(outsiderJob);
    for (const job of jobs) expect(["pending", "running", "pausing", "cancelling"]).toContain(job.status);
    for (const field of SESSION_FIELDS) expect(keys(jobs).has(field)).toBe(false);
  });

  test("status takes a comma-separated list", async () => {
    const { jobs } = await ok(admin("listJobs"), "staff", { params: { status: "failed,completed", limit: 200 } });
    const ids = jobs.map((j: { id: string }) => j.id);
    expect(ids).toContain(customerJob);
    for (const job of jobs) expect(["failed", "completed"]).toContain(job.status);
  });

  test("spaces around the statuses are ignored", async () => {
    const { jobs } = await ok(admin("listJobs"), "staff", { params: { status: " failed , completed ", limit: 200 } });
    expect(jobs.map((j: { id: string }) => j.id)).toContain(customerJob);
    for (const job of jobs) expect(["failed", "completed"]).toContain(job.status);
  });

  test("jobType filters by type", async () => {
    const { jobs } = await ok(admin("listJobs"), "staff", {
      params: { status: "completed", jobType: "no.such.type" },
    });
    expect(jobs).toEqual([]);
  });

  test("limit caps the list, newest first", async () => {
    const { jobs } = await ok(admin("listJobs"), "staff", {
      params: { status: "completed", jobType: "instance.operation", limit: 1 },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(outsiderJob);
  });

  test("bad params are InvalidRequest", async () => {
    for (const limit of [0, 201, -3, 1.5]) {
      await fails(admin("listJobs"), "staff", "InvalidRequest", { params: { limit } });
    }
    await fails(admin("listJobs"), "staff", "InvalidRequest", { params: { limit: "many" } });
    await fails(admin("listJobs"), "staff", "InvalidRequest", { params: { status: "done" } });
    await fails(admin("listJobs"), "staff", "InvalidRequest", { params: { status: "completed,,failed" } });
  });
});
