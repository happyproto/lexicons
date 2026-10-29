/**
 * The autoscaler's staff endpoints: the overview and its pause toggle, the
 * host-request history, one request's timeline, and retry and cancel. The
 * fake provisioner answers with api/autoscale.rs's shapes.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { ensureTestUser } from "./session";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const admin = (name: string) => `at.happyproto.admin.${name}`;

const FAILED_ID = "a0000000-0000-4000-8000-000000000001";
const LIVE_ID = "a0000000-0000-4000-8000-000000000002";
const DONE_ID = "a0000000-0000-4000-8000-000000000003";
const MISSING_ID = "a0000000-0000-4000-8000-0000000000ff";
const RUN = "https://github.com/happyproto/infrastructure/actions/runs/123";
const key = () => crypto.randomUUID();

const THRESHOLDS = { free_memory_mb: 2048, free_disk_gb: 50, sustain_secs: 600, cooldown_secs: 21600 };

function hostRequest(id: string, name: string, state: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    state,
    trigger: {
      free_memory_mb: 1024,
      free_disk_gb: 40,
      low_since: "2026-10-29T09:50:00Z",
      hosts: [{ name: "tenant-1", free_memory_mb: 1024, free_disk_gb: 40 }],
      thresholds: THRESHOLDS,
    },
    cost_eur: "13.10",
    requested_by: "system",
    workflow_run_id: 123,
    workflow_run_url: RUN,
    deploy_run_id: null,
    deploy_run_url: null,
    cancel_run_id: null,
    cancel_run_url: null,
    current_step: null,
    error: null,
    dispatched_at: createdAt,
    created_at: createdAt,
    updated_at: createdAt,
    finished_at: null,
    events: [
      { at: createdAt, kind: "requested", message: `Requested ${name}: 1024 MB / 40 GB free, below 2048 MB / 50 GB for 10 min`, detail: {} },
      {
        at: createdAt,
        kind: "step_finished",
        message: "Order the server failed",
        detail: { step_key: "k", workflow: "add-tenant-host.yml", run_id: 123, run_url: RUN, job: "add", step: "Order the server", conclusion: "failure" },
      },
    ],
    ...extra,
  };
}

let s: Stack;

async function seed(): Promise<void> {
  await provisioner.reset();
  await provisioner.state({
    staff: [s.accounts.staff.did],
    hostRequests: [
      hostRequest(DONE_ID, "tenant-2", "registered", "2026-10-27T10:00:00Z", { finished_at: "2026-10-27T10:20:00Z" }),
      hostRequest(FAILED_ID, "tenant-3", "failed", "2026-10-28T10:00:00Z", { error: `Order the server failed: ${RUN}` }),
      hostRequest(LIVE_ID, "tenant-4", "ordering", "2026-10-29T10:00:00Z", { current_step: "Order the server" }),
    ],
  });
}

beforeAll(async () => {
  s = await stack();
  await ensureTestUser(s.accounts.staff.did, true);
}, 180_000);

beforeEach(() => seed());

describe("refusals", () => {
  const calls: [string, { params?: Record<string, string>; input?: unknown }][] = [
    ["getAutoscale", {}],
    ["setAutoscalePaused", { input: { paused: true, idempotencyKey: key() } }],
    ["listHostRequests", {}],
    ["getHostRequest", { params: { id: FAILED_ID } }],
    ["retryHostRequest", { input: { id: FAILED_ID, idempotencyKey: key() } }],
    ["cancelHostRequest", { input: { id: FAILED_ID, confirm: "tenant-3", idempotencyKey: key() } }],
  ];
  for (const [name, options] of calls) {
    test(`${name} is Forbidden to a customer and an outsider, and sends nothing`, async () => {
      await fails(admin(name), "customer", "Forbidden", options);
      await fails(admin(name), "outsider", "Forbidden", options);
      expect(await provisioner.requests()).toEqual([]);
    });
  }
});

describe("admin.getAutoscale and setAutoscalePaused", () => {
  test("the overview, in camelCase", async () => {
    expect(await ok(admin("getAutoscale"), "staff")).toEqual({
      autoscale: {
        enabled: true,
        paused: false,
        maxHosts: 3,
        hosts: 1,
        inFlight: 0,
        costEur: "13.10",
        thresholds: { freeMemoryMb: 2048, freeDiskGb: 50, sustainSecs: 600, cooldownSecs: 21600 },
        current: { freeMemoryMb: 3072, freeDiskGb: 120 },
      },
    });
  });

  test("pause records who, resume clears it, and the key goes along", async () => {
    const idempotencyKey = key();
    const paused = await ok(admin("setAutoscalePaused"), "staff", { input: { paused: true, idempotencyKey } });
    expect(paused.autoscale).toMatchObject({ paused: true, pausedBy: s.accounts.staff.did });
    expect(typeof paused.autoscale.pausedAt).toBe("string");
    const [request] = await provisioner.requests();
    expect(request.method).toBe("PATCH");
    expect(request.path).toBe("/v1/autoscale");
    expect(request.headers["idempotency-key"]).toBe(idempotencyKey);
    expect(request.body).toEqual({ paused: true });

    const resumed = await ok(admin("setAutoscalePaused"), "staff", { input: { paused: false, idempotencyKey: key() } });
    expect(resumed.autoscale.paused).toBe(false);
    expect(resumed.autoscale.pausedBy).toBeUndefined();
  });

  test("paused must be a boolean, and nothing is sent otherwise", async () => {
    await fails(admin("setAutoscalePaused"), "staff", "InvalidRequest", { input: { paused: "yes", idempotencyKey: key() } });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("a blocked autoscaler names the request holding it", async () => {
    await provisioner.state({
      autoscale: {
        enabled: true, paused: false, paused_by: null, paused_at: null, max_hosts: 3, hosts: 2, in_flight: 0,
        blocked_by: FAILED_ID, cost_eur: null, thresholds: THRESHOLDS, low_since: "2026-10-29T09:00:00Z",
        cooldown_until: "2026-10-29T16:00:00Z", current: { free_memory_mb: 0, free_disk_gb: 10 },
      },
    });
    const { autoscale } = await ok(admin("getAutoscale"), "staff");
    expect(autoscale).toMatchObject({
      blockedBy: FAILED_ID,
      lowSince: "2026-10-29T09:00:00Z",
      cooldownUntil: "2026-10-29T16:00:00Z",
      current: { freeMemoryMb: 0, freeDiskGb: 10 },
    });
    expect(autoscale.costEur).toBeUndefined();
  });
});

describe("admin.listHostRequests and getHostRequest", () => {
  test("newest first, as summaries without timelines", async () => {
    const { requests } = await ok(admin("listHostRequests"), "staff");
    expect(requests.map((r: { name: string }) => r.name)).toEqual(["tenant-4", "tenant-3", "tenant-2"]);
    expect(requests[0]).toEqual({
      id: LIVE_ID,
      name: "tenant-4",
      state: "ordering",
      trigger: {
        freeMemoryMb: 1024,
        freeDiskGb: 40,
        lowSince: "2026-10-29T09:50:00Z",
        hosts: [{ name: "tenant-1", freeMemoryMb: 1024, freeDiskGb: 40 }],
        thresholds: { freeMemoryMb: 2048, freeDiskGb: 50, sustainSecs: 600, cooldownSecs: 21600 },
      },
      costEur: "13.10",
      requestedBy: "system",
      workflowRunUrl: RUN,
      currentStep: "Order the server",
      dispatchedAt: "2026-10-29T10:00:00Z",
      createdAt: "2026-10-29T10:00:00Z",
      updatedAt: "2026-10-29T10:00:00Z",
    });
    const [request] = await provisioner.requests();
    expect(request.path).toBe("/v1/host-requests");
    expect(request.query).toEqual({ limit: "50" });
  });

  test("pages with limit and before", async () => {
    const { requests } = await ok(admin("listHostRequests"), "staff", { params: { limit: "1", before: LIVE_ID } });
    expect(requests.map((r: { name: string }) => r.name)).toEqual(["tenant-3"]);
  });

  test("a bad limit or before is InvalidRequest, and nothing is sent", async () => {
    await fails(admin("listHostRequests"), "staff", "InvalidRequest", { params: { limit: "500" } });
    await fails(admin("listHostRequests"), "staff", "InvalidRequest", { params: { before: "x" } });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("one request's timeline, with run links and nothing else from the detail", async () => {
    const { request } = await ok(admin("getHostRequest"), "staff", { params: { id: FAILED_ID } });
    expect(request.error).toBe(`Order the server failed: ${RUN}`);
    expect(request.events).toEqual([
      { at: "2026-10-28T10:00:00Z", kind: "requested", message: "Requested tenant-3: 1024 MB / 40 GB free, below 2048 MB / 50 GB for 10 min" },
      { at: "2026-10-28T10:00:00Z", kind: "step_finished", message: "Order the server failed", runUrl: RUN },
    ]);
  });

  test("a missing request is NotFound", async () => {
    await fails(admin("getHostRequest"), "staff", "NotFound", { params: { id: MISSING_ID } });
  });
});

describe("admin.retryHostRequest", () => {
  test("a failed request starts again", async () => {
    const idempotencyKey = key();
    const { request } = await ok(admin("retryHostRequest"), "staff", { input: { id: FAILED_ID, idempotencyKey } });
    expect(request.state).toBe("requested");
    expect(request.error).toBeUndefined();
    expect(request.events.at(-1)).toMatchObject({ kind: "retried" });
    const [sent] = await provisioner.requests();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe(`/v1/host-requests/${FAILED_ID}/retry`);
    expect(sent.headers["idempotency-key"]).toBe(idempotencyKey);
  });

  test("anything but a failed request is NotRetryable, with the provisioner's words", async () => {
    const reply = await fails(admin("retryHostRequest"), "staff", "NotRetryable", { input: { id: LIVE_ID, idempotencyKey: key() } });
    expect(reply.body.message).toBe("only a failed request can be retried");
  });

  test("the provisioner's own refusals pass through", async () => {
    for (const [status, code] of [
      [409, "RequestInFlight"],
      [409, "ScalerNotConfigured"],
      [409, "HostRegistered"],
      [502, "DispatchFailed"],
    ] as const) {
      await provisioner.script("POST", `/v1/host-requests/${FAILED_ID}/retry`, status, { error: code, message: `${code} said` });
      const reply = await fails(admin("retryHostRequest"), "staff", code, { input: { id: FAILED_ID, idempotencyKey: key() } });
      expect(reply.body.message).toBe(`${code} said`);
    }
  });

  test("an unexplained 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("POST", `/v1/host-requests/${FAILED_ID}/retry`, 500, { error: "Internal", message: "SENTINEL-retry" });
    const reply = await fails(admin("retryHostRequest"), "staff", "Upstream", { input: { id: FAILED_ID, idempotencyKey: key() } });
    expect(reply.text).not.toContain("SENTINEL");
  });
});

describe("admin.cancelHostRequest", () => {
  test("the typed name goes along, and the request starts cancelling", async () => {
    const { request } = await ok(admin("cancelHostRequest"), "staff", {
      input: { id: FAILED_ID, confirm: "tenant-3", idempotencyKey: key() },
    });
    expect(request.state).toBe("cancelling");
    expect(request.events.at(-1)).toMatchObject({ kind: "cancel_requested" });
    const [sent] = await provisioner.requests();
    expect(sent.path).toBe(`/v1/host-requests/${FAILED_ID}/cancel`);
    expect(sent.body).toEqual({ confirm: "tenant-3" });
  });

  test("the wrong name is ConfirmationMismatch, and the request is unchanged", async () => {
    await fails(admin("cancelHostRequest"), "staff", "ConfirmationMismatch", {
      input: { id: FAILED_ID, confirm: "tenant-4", idempotencyKey: key() },
    });
    const { request } = await ok(admin("getHostRequest"), "staff", { params: { id: FAILED_ID } });
    expect(request.state).toBe("failed");
  });

  test("a registered request is NotCancellable", async () => {
    await fails(admin("cancelHostRequest"), "staff", "NotCancellable", {
      input: { id: DONE_ID, confirm: "tenant-2", idempotencyKey: key() },
    });
  });

  test("no name is InvalidRequest, and nothing is sent", async () => {
    await fails(admin("cancelHostRequest"), "staff", "InvalidRequest", { input: { id: FAILED_ID, confirm: "", idempotencyKey: key() } });
    expect(await provisioner.requests()).toEqual([]);
  });
});
