/**
 * The customer write endpoints -- create, update, start, stop and delete --
 * the instance.operation job that follows each one, and getJob, on a real
 * HappyView v3 against the fake provisioner.
 *
 * HappyView's job worker polls every few seconds and runs at most
 * JOB_WORKER_CONCURRENCY jobs at once (4 in compose.yml), so every job this
 * file starts must finish on its own: an operation nobody scripted succeeds
 * at its first read, and one the provisioner will not report fails its job
 * at once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner, type ProvisionerRequest } from "./fakes";
import { PROVISIONER_TOKEN, putMember, removeMember, stack, type Stack } from "./setup";
import { call, fails, ok } from "./xrpc";

const server = (name: string) => `at.happyproto.server.${name}`;

const RUNNING_ID = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSES_ID = "44444444-4444-4444-8444-444444444444";
const BUSY_ID = "88888888-8888-4888-8888-888888888888";
const BUSY_OP_ID = "99999999-9999-4999-8999-999999999990";
const NOT_LIVE_ID = "22222222-2222-4222-8222-222222222222";
const NOT_LIVE_OP_ID = "55555555-5555-4555-8555-555555555555";

const JOB_TIMEOUT = 90_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "paused"]);

/** A tenant row with every column the provisioner's Tenant serialises. */
function tenant(id: string, slug: string, owner: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: "99999999-9999-4999-8999-999999999999",
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

/**
 * Requests the scripts made, leaving out the jobs' operation polls: a job
 * from an earlier test can poll at any moment.
 */
async function sent(): Promise<ProvisionerRequest[]> {
  return (await provisioner.requests()).filter(
    (r) => !(r.method === "GET" && r.path.startsWith("/v1/operations/")),
  );
}

/** Every job this file started, as [owner, id], so afterAll can drain them. */
const started: ["customer" | "outsider", string][] = [];

/** Poll getJob until the job ends, returning every reply seen on the way. */
async function untilDone(jobId: string, who: "customer" | "outsider" = "customer"): Promise<any[]> {
  const seen: any[] = [];
  const deadline = Date.now() + JOB_TIMEOUT - 5_000;
  while (Date.now() < deadline) {
    const { job } = await ok(server("getJob"), who, { params: { id: jobId } });
    seen.push(job);
    if (TERMINAL.has(job.status)) return seen;
    await Bun.sleep(250);
  }
  throw new Error(`job ${jobId} did not finish: last seen ${JSON.stringify(seen.at(-1))}`);
}

let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  const { customer } = s.accounts;
  await provisioner.state({
    instanceLimit: 10,
    tenants: [
      tenant(RUNNING_ID, "alpha", customer.did),
      tenant(SOMEONE_ELSES_ID, "gamma", "did:plc:someoneelseentirely"),
      tenant(BUSY_ID, "busy", customer.did),
      tenant(NOT_LIVE_ID, "settling", customer.did, {
        routed: false,
        observed_state: "pending",
        owner_confirmed_at: null,
      }),
    ],
    operations: [
      {
        id: BUSY_OP_ID,
        tenant_id: BUSY_ID,
        kind: "stop",
        status: "running",
        params: {},
        steps: [],
        error_code: null,
        error_message: null,
        requested_by: customer.did,
        created_at: "2026-10-01T12:00:00Z",
        started_at: "2026-10-01T12:00:01Z",
        finished_at: null,
      },
      {
        id: NOT_LIVE_OP_ID,
        tenant_id: NOT_LIVE_ID,
        kind: "create",
        status: "running",
        params: {},
        steps: [{ name: "pull_image", at: "2026-10-01T12:00:02Z" }],
        error_code: null,
        error_message: null,
        requested_by: customer.did,
        created_at: "2026-10-01T12:00:00Z",
        started_at: "2026-10-01T12:00:01Z",
        finished_at: null,
      },
    ],
  });
});

/** Requests that could have changed something: anything but a GET. */
async function writes(): Promise<ProvisionerRequest[]> {
  return (await sent()).filter((r) => r.method !== "GET");
}

afterAll(async () => {
  // Leave the worker idle for whatever runs next.
  for (const [who, id] of started) {
    try {
      await untilDone(id, who);
    } catch {
      // Reported by the test that started it, if it mattered.
    }
  }
}, 300_000);

describe("server.createInstance", () => {
  test("creates the instance as the caller, with their key, and starts a job", async () => {
    const key = crypto.randomUUID();
    const out = await ok(server("createInstance"), "customer", {
      input: { slug: "fresh-slug", plan: "small", idempotencyKey: key },
    });
    started.push(["customer", out.jobId]);

    expect(typeof out.jobId).toBe("string");
    expect(out.instance).toMatchObject({
      slug: "fresh-slug",
      url: "https://fresh-slug.happyview.app",
      plan: "small",
      state: "provisioning",
      operation: { kind: "create", status: "pending" },
    });
    for (const field of ["host_id", "image", "spec_hash", "routed", "owner_did", "owner_confirmed_at"]) {
      expect(field in out.instance).toBe(false);
    }

    const [request, ...rest] = await sent();
    expect(rest).toEqual([]);
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/tenants");
    expect(request.body).toEqual({ owner_did: s.accounts.customer.did, slug: "fresh-slug", plan: "small" });
    expect(request.headers["idempotency-key"]).toBe(key);
    expect(request.headers["x-actor-did"]).toBe(s.accounts.customer.did);
    expect(request.headers.authorization).toBe(`Bearer ${PROVISIONER_TOKEN}`);
  });

  test("Review Focus 2: a retry with the same key gets the same instance, not SlugTaken", async () => {
    const input = { slug: "retried", plan: "small", idempotencyKey: crypto.randomUUID() };
    const first = await ok(server("createInstance"), "customer", { input });
    const second = await ok(server("createInstance"), "customer", { input });
    started.push(["customer", first.jobId], ["customer", second.jobId]);

    expect(second.instance.id).toBe(first.instance.id);
    const posts = (await sent()).filter((r) => r.method === "POST" && r.path === "/v1/tenants");
    expect(posts).toHaveLength(2);
    expect(posts.map((r) => r.headers["idempotency-key"])).toEqual([
      input.idempotencyKey,
      input.idempotencyKey,
    ]);
  });

  test("bad input is InvalidRequest, and nothing is sent", async () => {
    const good = { slug: "fresh-slug", plan: "small", idempotencyKey: crypto.randomUUID() };
    const bad: Record<string, unknown>[] = [
      { ...good, idempotencyKey: undefined },
      { ...good, idempotencyKey: "" },
      { ...good, idempotencyKey: "not-a-uuid" },
      { ...good, slug: "Bad Slug" },
      { ...good, slug: "ab" },
      { ...good, slug: "www" },
      { ...good, slug: undefined },
      { ...good, plan: "" },
      { ...good, plan: undefined },
    ];
    for (const input of bad) {
      await fails(server("createInstance"), "customer", "InvalidRequest", { input });
    }
    expect(await sent()).toEqual([]);
  });

  test("a provisioner refusal passes through with its code and message", async () => {
    const refusals: [number, string][] = [
      [409, "SlugTaken"],
      [409, "InstanceLimit"],
      [503, "NoCapacity"],
      [409, "OperationInProgress"],
      [404, "NotFound"],
    ];
    for (const [status, code] of refusals) {
      await provisioner.script("POST", "/v1/tenants", status, { error: code, message: `said ${code}` });
      const reply = await fails(server("createInstance"), "customer", code, {
        input: { slug: "fresh-slug", plan: "small", idempotencyKey: crypto.randomUUID() },
      });
      expect(reply.body.message).toBe(`said ${code}`);
    }
  });

  test("the fake's own SlugTaken, from a held slug", async () => {
    await fails(server("createInstance"), "customer", "SlugTaken", {
      input: { slug: "alpha", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
  });

  test("a 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("POST", "/v1/tenants", 500, { error: "Boom", message: "SENTINEL-901" });
    const reply = await fails(server("createInstance"), "customer", "Upstream", {
      input: { slug: "fresh-slug", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    expect(reply.text).not.toContain("SENTINEL-901");
  });
});

describe("the instance.operation job", () => {
  test("follows the operation to success, reporting its step", async () => {
    await provisioner.progress([
      { status: "pending" },
      { status: "running", step: "apply" },
      { status: "running", step: "apply" },
      { status: "succeeded", step: "apply" },
    ]);
    const { jobId } = await ok(server("createInstance"), "customer", {
      input: { slug: "followed", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);

    const seen = await untilDone(jobId);
    const last = seen.at(-1);
    expect(last.id).toBe(jobId);
    expect(last.status).toBe("completed");
    expect(last.result).toEqual({ status: "succeeded" });
    expect(seen.some((job) => job.progress?.step === "apply")).toBe(true);
    for (const field of ["inherit_auth", "api_client_id", "dpop_key_id", "input", "created_by"]) {
      expect(field in last).toBe(false);
    }

    // It polled as the job's creator, with the token.
    const polls = (await provisioner.requests()).filter((r) => r.path.startsWith("/v1/operations/"));
    expect(polls.length).toBeGreaterThanOrEqual(4);
    for (const poll of polls) {
      expect(poll.headers["x-actor-did"]).toBe(s.accounts.customer.did);
      expect(poll.headers.authorization).toBe(`Bearer ${PROVISIONER_TOKEN}`);
    }
  }, JOB_TIMEOUT);

  test("fails with the operation's error code and message", async () => {
    await provisioner.progress([
      { status: "running", step: "place" },
      { status: "failed", step: "place", error_code: "NoCapacity", error_message: "no host has room" },
    ]);
    const { jobId } = await ok(server("createInstance"), "customer", {
      input: { slug: "doomed", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);

    const last = (await untilDone(jobId)).at(-1);
    expect(last.status).toBe("failed");
    expect(last.error).toContain("NoCapacity");
    expect(last.error).toContain("no host has room");
  }, JOB_TIMEOUT);

  test("an operation's raw message is replaced unless its code's text is fixed", async () => {
    await provisioner.progress([
      { status: "failed", step: "apply", error_code: "AgentError", error_message: "SENTINEL-agent /var/lib/x refused" },
    ]);
    const { jobId } = await ok(server("createInstance"), "customer", {
      input: { slug: "leaky", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);

    const last = (await untilDone(jobId)).at(-1);
    expect(last.status).toBe("failed");
    expect(last.error).toContain("AgentError: The change could not be completed.");
    expect(JSON.stringify(last)).not.toContain("SENTINEL");
  }, JOB_TIMEOUT);

  test("fails on a timed-out operation too", async () => {
    await provisioner.progress([
      { status: "timeout", step: "wait_healthy", error_code: "Timeout", error_message: "never became healthy" },
    ]);
    const { jobId } = await ok(server("createInstance"), "customer", {
      input: { slug: "slowpoke", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);

    const last = (await untilDone(jobId)).at(-1);
    expect(last.status).toBe("failed");
    expect(last.error).toContain("Timeout: never became healthy");
  }, JOB_TIMEOUT);

  test("a poll answered with a 5xx is tried again, not the end of the job", async () => {
    await provisioner.progress([{ http: 503 }, { http: 502 }, { status: "succeeded", step: "apply" }]);
    const { jobId } = await ok(server("createInstance"), "customer", {
      input: { slug: "flaky", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);

    const last = (await untilDone(jobId)).at(-1);
    expect(last.status).toBe("completed");
    const polls = (await provisioner.requests()).filter((r) => r.path.startsWith("/v1/operations/"));
    expect(polls.length).toBeGreaterThanOrEqual(3);
  }, JOB_TIMEOUT);

  test("an operation the provisioner will not report fails the job at once", async () => {
    // Gone, or never the creator's: asking again will not change the answer,
    // and the job must not hold a worker for 15 minutes asking.
    await provisioner.progress([{ http: 404, error: "NotFound" }]);
    const { jobId } = await ok(server("createInstance"), "customer", {
      input: { slug: "vanished", plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);

    const last = (await untilDone(jobId)).at(-1);
    expect(last.status).toBe("failed");
    expect(last.error).toContain("NotFound");
    expect(last.error).not.toContain("SENTINEL");
    const polls = (await provisioner.requests()).filter((r) => r.path.startsWith("/v1/operations/"));
    expect(polls).toHaveLength(1);
  }, JOB_TIMEOUT);
});

describe("server.getJob", () => {
  test("a non-UUID id is InvalidRequest", async () => {
    await fails(server("getJob"), "customer", "InvalidRequest", { params: { id: "nope" } });
    await fails(server("getJob"), "customer", "InvalidRequest");
  });

  test("anonymous callers and non-customers are refused", async () => {
    const id = crypto.randomUUID();
    await fails(server("getJob"), null, "AuthRequired", { params: { id } });
    await fails(server("getJob"), "outsider", "Forbidden", { params: { id } });
  });

  describe("Review Focus 1: another customer's job looks exactly like no job", () => {
    beforeEach(async () => {
      await putMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.outsider.did);
    });
    afterEach(async () => {
      await removeMember(s.accounts.happyproto, s.client.key, s.spaces.customers, s.accounts.outsider.did);
    });

    test("NotFound for both, with identical replies", async () => {
      const { jobId } = await ok(server("createInstance"), "customer", {
        input: { slug: "private", plan: "small", idempotencyKey: crypto.randomUUID() },
      });
      started.push(["customer", jobId]);
      // The job is real: its creator can read it.
      await ok(server("getJob"), "customer", { params: { id: jobId } });

      const theirs = await fails(server("getJob"), "outsider", "NotFound", { params: { id: jobId } });
      const none = await fails(server("getJob"), "outsider", "NotFound", {
        params: { id: crypto.randomUUID() },
      });
      expect(theirs.text).toBe(none.text);
    });
  });
});

describe("changes to an existing instance", () => {
  const cases: [string, Record<string, unknown>, string, string, unknown][] = [
    ["updateInstance", { plan: "medium" }, "PATCH", `/v1/tenants/${RUNNING_ID}`, { plan: "medium" }],
    ["updateInstance", { version: "3.0.0-alpha.5" }, "PATCH", `/v1/tenants/${RUNNING_ID}`, { version: "3.0.0-alpha.5" }],
    ["startInstance", {}, "POST", `/v1/tenants/${RUNNING_ID}/start`, null],
    ["stopInstance", {}, "POST", `/v1/tenants/${RUNNING_ID}/stop`, null],
    ["deleteInstance", {}, "DELETE", `/v1/tenants/${RUNNING_ID}`, null],
  ];
  for (const [name, extra, method, path, body] of cases) {
    test(`${name} ${JSON.stringify(extra)} calls ${method} ${path} and starts a job`, async () => {
      const key = crypto.randomUUID();
      const out = await ok(server(name), "customer", {
        input: { id: RUNNING_ID, idempotencyKey: key, ...extra },
      });
      started.push(["customer", out.jobId]);
      expect(Object.keys(out)).toEqual(["jobId"]);
      expect(typeof out.jobId).toBe("string");

      // Ownership first, then the change itself.
      const [check, request, ...rest] = await sent();
      expect(rest).toEqual([]);
      expect({ method: check.method, path: check.path }).toEqual({ method: "GET", path: `/v1/tenants/${RUNNING_ID}` });
      expect({ method: request.method, path: request.path }).toEqual({ method, path });
      if (body !== null) expect(request.body).toEqual(body);
      expect(request.headers["idempotency-key"]).toBe(key);
      expect(request.headers["x-actor-did"]).toBe(s.accounts.customer.did);

      // Its job follows that operation to the end.
      const last = (await untilDone(out.jobId)).at(-1);
      expect(last.status).toBe("completed");
    }, JOB_TIMEOUT);
  }

  test("bad input is InvalidRequest, and nothing is sent", async () => {
    const key = crypto.randomUUID();
    for (const name of ["updateInstance", "startInstance", "stopInstance", "deleteInstance"]) {
      const plan = name === "updateInstance" ? { plan: "medium" } : {};
      await fails(server(name), "customer", "InvalidRequest", { input: { id: "../plans", idempotencyKey: key, ...plan } });
      await fails(server(name), "customer", "InvalidRequest", { input: { idempotencyKey: key, ...plan } });
      await fails(server(name), "customer", "InvalidRequest", { input: { id: RUNNING_ID, ...plan } });
      await fails(server(name), "customer", "InvalidRequest", {
        input: { id: RUNNING_ID, idempotencyKey: "nope", ...plan },
      });
    }
    // An update that changes nothing is refused before it is sent.
    await fails(server("updateInstance"), "customer", "InvalidRequest", {
      input: { id: RUNNING_ID, idempotencyKey: key },
    });
    expect(await sent()).toEqual([]);
  });

  test("someone else's instance is NotFound", async () => {
    for (const name of ["updateInstance", "startInstance", "stopInstance", "deleteInstance"]) {
      await fails(server(name), "customer", "NotFound", {
        input: { id: SOMEONE_ELSES_ID, idempotencyKey: crypto.randomUUID(), plan: "medium" },
      });
    }
    expect(await writes()).toEqual([]);
  });

  test("an instance with an operation in progress is OperationInProgress", async () => {
    await fails(server("startInstance"), "customer", "OperationInProgress", {
      input: { id: BUSY_ID, idempotencyKey: crypto.randomUUID() },
    });
  });

  test("an instance not yet live is OperationInProgress, with the fixed text", async () => {
    // The provisioner answers NotLive before OperationInProgress here, though
    // the create is still running.
    const reply = await fails(server("startInstance"), "customer", "OperationInProgress", {
      input: { id: NOT_LIVE_ID, idempotencyKey: crypto.randomUUID() },
    });
    expect(reply.body.message).toBe("This instance has not finished setting up yet.");
  });

  test("the fake's own NoChange and UnknownPlan are InvalidRequest, with their text", async () => {
    const same = await fails(server("updateInstance"), "customer", "InvalidRequest", {
      input: { id: RUNNING_ID, plan: "small", idempotencyKey: crypto.randomUUID() },
    });
    expect(same.body.message).toBe("the instance already has that plan and version");
    const unknown = await fails(server("updateInstance"), "customer", "InvalidRequest", {
      input: { id: RUNNING_ID, plan: "huge", idempotencyKey: crypto.randomUUID() },
    });
    expect(unknown.body.message).toBe("no such plan");
  });

  test("provisioner codes with no customer meaning are remapped", async () => {
    const path = `/v1/tenants/${RUNNING_ID}`;
    const cases: [number, string, string, string][] = [
      [400, "UnknownPlan", "InvalidRequest", "said UnknownPlan"],
      [400, "InvalidVersion", "InvalidRequest", "said InvalidVersion"],
      [400, "NoChange", "InvalidRequest", "said NoChange"],
      [400, "EmptyUpdate", "InvalidRequest", "said EmptyUpdate"],
      [422, "IdempotencyKeyReused", "InvalidRequest", "said IdempotencyKeyReused"],
      [409, "TenantDeleted", "NotFound", "instance not found"],
      [409, "NotLive", "OperationInProgress", "This instance has not finished setting up yet."],
    ];
    for (const [status, code, mapped, message] of cases) {
      await provisioner.script("PATCH", path, status, { error: code, message: `said ${code}` });
      const reply = await fails(server("updateInstance"), "customer", mapped, {
        input: { id: RUNNING_ID, plan: "medium", idempotencyKey: crypto.randomUUID() },
      });
      expect([code, reply.body.message]).toEqual([code, message]);
    }
  });
});

describe("Fix round 1: a customer the provisioner treats as staff", () => {
  // The provisioner lets staff act on ANY tenant. A staff member who is also
  // a customer must still reach only their own through these endpoints.
  beforeEach(async () => {
    await provisioner.state({ staff: [s.accounts.customer.did] });
  });

  for (const name of ["updateInstance", "startInstance", "stopInstance", "deleteInstance"]) {
    test(`${name} on another owner's instance is NotFound, and nothing is changed`, async () => {
      const reply = await fails(server(name), "customer", "NotFound", {
        input: { id: SOMEONE_ELSES_ID, plan: "medium", idempotencyKey: crypto.randomUUID() },
      });
      expect(reply.body.message).toBe("instance not found");
      expect(await writes()).toEqual([]);
      // The provisioner did hand the tenant over: only the script refused.
      expect((await sent()).map((r) => `${r.method} ${r.path}`)).toEqual([
        `GET /v1/tenants/${SOMEONE_ELSES_ID}`,
      ]);
    });
  }

  test("their own instance still works", async () => {
    const { jobId } = await ok(server("stopInstance"), "customer", {
      input: { id: RUNNING_ID, idempotencyKey: crypto.randomUUID() },
    });
    started.push(["customer", jobId]);
  });
});

describe("refusals", () => {
  const inputs: [string, Record<string, unknown>][] = [
    ["createInstance", { slug: "fresh-slug", plan: "small" }],
    ["updateInstance", { id: RUNNING_ID, plan: "medium" }],
    ["startInstance", { id: RUNNING_ID }],
    ["stopInstance", { id: RUNNING_ID }],
    ["deleteInstance", { id: RUNNING_ID }],
  ];
  for (const [name, input] of inputs) {
    test(`${name} refuses non-customers before anything is sent`, async () => {
      const full = { ...input, idempotencyKey: crypto.randomUUID() };
      await fails(server(name), "outsider", "Forbidden", { input: full });
      await fails(server(name), "staff", "Forbidden", { input: full });
      // HappyView refuses an anonymous procedure itself, before the script
      // runs, so the script's AuthRequired is only reachable for queries.
      const anonymous = await call(server(name), null, { input: full });
      expect(anonymous.status).toBe(401);
      expect(await sent()).toEqual([]);
    });
  }
});

test("the read endpoints still answer for an instance a write created", async () => {
  const { instance, jobId } = await ok(server("createInstance"), "customer", {
    input: { slug: "listed", plan: "small", idempotencyKey: crypto.randomUUID() },
  });
  started.push(["customer", jobId]);
  const { instances } = await ok(server("listInstances"), "customer");
  expect(instances.map((i: { id: string }) => i.id)).toContain(instance.id);
  const reply = await call(server("getInstance"), "customer", { params: { id: instance.id } });
  expect(reply.body.instance.id).toBe(instance.id);
});
