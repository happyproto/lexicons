/**
 * A tenant's script and ingest metrics: the owner's server methods and
 * staff's fleet methods, on a real HappyView v3 against the fake
 * provisioner's /metrics relay, which answers HappyView's own bodies.
 *
 * Every successful reply is validated against its lexicon's output schema
 * (see xrpc.ts), so a duration that goes out as a float, or an outcome that
 * goes missing, fails here.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const server = (name: string) => `at.happyproto.server.${name}`;
const fleet = (name: string) => `at.happyproto.fleet.${name}`;

const OWN_ID = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSES_ID = "44444444-4444-4444-8444-444444444444";
const TRIGGER = "xrpc.query:com.example.getThing";
const ENCODED = "xrpc.query%3Acom.example.getThing";

const ZERO = {
  ok: 0, syntax: 0, runtime: 0, missingHandle: 0, timeout: 0,
  memory: 0, trap: 0, noInterpreter: 0, error: 0,
};

/** What the fixture in fake-provisioner.ts maps to. */
const SCRIPTS = [
  {
    trigger: TRIGGER,
    kind: "xrpc_query",
    layer: "project",
    runs: 42,
    outcomes: { ...ZERO, ok: 40, runtime: 1, timeout: 1 },
    wallUs: { p50: 1234, p95: 8500, p99: 12001, max: 30250, mean: 2500 },
    memoryPeakBytes: 1048576,
  },
  {
    trigger: "job.run:com.example.sweep",
    kind: "job",
    layer: "dashboard",
    runs: 1,
    outcomes: ZERO,
    wallUs: {},
  },
];
const SERIES = {
  step: "1m",
  enabled: true,
  script: {
    trigger: TRIGGER,
    kind: "xrpc_query",
    runs: 42,
    outcomes: { ...ZERO, ok: 40, runtime: 1, timeout: 1 },
    wallUs: { p50: 1234, p95: 8500, p99: 12001, max: 30250, mean: 2500 },
  },
  points: [
    {
      start: "2026-11-05T10:00:00+00:00",
      runs: 40,
      outcomes: { ...ZERO, ok: 40 },
      wallUs: { p50: 1100, p95: 8000, max: 30250 },
    },
    { start: "2026-11-05T10:01:00+00:00", runs: 0, outcomes: ZERO, wallUs: {} },
  ],
};
const COLLECTIONS = [
  {
    collection: "com.example.post",
    action: "create",
    records: 1200,
    failed: 2,
    timeouts: 1,
    deadLettered: 1,
    recordUs: { p50: 250, p95: 2500, p99: 4000, max: 9000, mean: 500 },
  },
];

let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  const { customer, staff } = s.accounts;
  const tenant = (id: string, slug: string, owner: string) => ({
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: "99999999-9999-4999-8999-999999999999",
    happyview_version: "3.0.0-alpha.3",
    public_url: `https://${slug}.happyview.app`,
    desired_state: "running",
    observed_state: "running",
    created_at: "2026-10-01T12:00:00Z",
    deleted_at: null,
  });
  await provisioner.state({
    staff: [staff.did],
    tenants: [tenant(OWN_ID, "alpha", customer.did), tenant(SOMEONE_ELSES_ID, "gamma", "did:plc:someoneelseentirely")],
  });
});

const metricReads = async () => (await provisioner.requests()).filter((r) => r.path.includes("/metrics/"));

describe("server.getScriptMetrics", () => {
  test("lists the owner's scripts in whole microseconds, with every outcome", async () => {
    const out = await ok(server("getScriptMetrics"), "customer", { params: { id: OWN_ID } });
    expect(out).toEqual({ window: "1h", enabled: true, scripts: SCRIPTS });
    const sent = await metricReads();
    expect(sent.map((r) => r.path)).toEqual([`/v1/tenants/${OWN_ID}/metrics/scripts`]);
    // HappyView fills in the lexicon's default window.
    expect(sent[0].query).toEqual({ window: "1h" });
    expect(sent[0].headers["x-actor-did"]).toBe(s.accounts.customer.did);
  });

  test("a stored window carries the retention, and step is not sent without a trigger", async () => {
    const out = await ok(server("getScriptMetrics"), "customer", { params: { id: OWN_ID, window: "7d", step: "1h" } });
    expect(out.retentionDays).toBe(30);
    expect(out.window).toBe("7d");
    expect((await metricReads())[0].query).toEqual({ window: "7d" });
  });

  test("with a trigger, answers that script's series, the trigger encoded in the path", async () => {
    const out = await ok(server("getScriptMetrics"), "customer", {
      params: { id: OWN_ID, trigger: TRIGGER, window: "1h", step: "1m" },
    });
    expect(out).toEqual({ window: "1h", ...SERIES });
    const sent = await metricReads();
    expect(sent.map((r) => r.path)).toEqual([`/v1/tenants/${OWN_ID}/metrics/scripts/${ENCODED}`]);
    expect(sent[0].query).toEqual({ window: "1h", step: "1m" });
  });

  test("a trigger with no runs is ScriptNotRun, in the provisioner's words", async () => {
    const reply = await fails(server("getScriptMetrics"), "customer", "ScriptNotRun", {
      params: { id: OWN_ID, trigger: "xrpc.query:com.example.never" },
    });
    expect(reply.body.message).toBe("'xrpc.query:com.example.never' has not run in the last hour");
  });

  test("someone else's instance is NotFound, and their metrics are never read", async () => {
    await fails(server("getScriptMetrics"), "customer", "NotFound", { params: { id: SOMEONE_ELSES_ID } });
    expect(await metricReads()).toEqual([]);
  });

  test("a bad id, window, step or trigger is InvalidRequest before anything is read", async () => {
    const bad: Record<string, string>[] = [
      { id: "../plans" },
      { id: OWN_ID, window: "2h" },
      { id: OWN_ID, trigger: TRIGGER, step: "5m" },
      { id: OWN_ID, trigger: "../x" },
      { id: OWN_ID, trigger: "a/b" },
      { id: OWN_ID, trigger: "a".repeat(301) },
    ];
    for (const params of bad) {
      await fails(server("getScriptMetrics"), "customer", "InvalidRequest", { params });
    }
    expect(await provisioner.requests()).toEqual([]);
  });

  test("is Forbidden to non-customers, staff included", async () => {
    await fails(server("getScriptMetrics"), "outsider", "Forbidden", { params: { id: OWN_ID } });
    await fails(server("getScriptMetrics"), "staff", "Forbidden", { params: { id: OWN_ID } });
    await fails(server("getScriptMetrics"), null, "AuthRequired", { params: { id: OWN_ID } });
    expect(await provisioner.requests()).toEqual([]);
  });
});

describe("server.getIngestMetrics", () => {
  test("answers the owner's collections, without the rate, stages or shares", async () => {
    const out = await ok(server("getIngestMetrics"), "customer", { params: { id: OWN_ID, window: "24h" } });
    expect(out).toEqual({ window: "24h", enabled: true, collections: COLLECTIONS });
    const sent = await metricReads();
    expect(sent.map((r) => r.path)).toEqual([`/v1/tenants/${OWN_ID}/metrics/ingest`]);
    expect(sent[0].query).toEqual({ window: "24h" });
  });

  test("someone else's instance is NotFound, and their metrics are never read", async () => {
    await fails(server("getIngestMetrics"), "customer", "NotFound", { params: { id: SOMEONE_ELSES_ID } });
    expect(await metricReads()).toEqual([]);
  });

  test("a bad window is InvalidRequest, and outsiders are Forbidden", async () => {
    await fails(server("getIngestMetrics"), "customer", "InvalidRequest", { params: { id: OWN_ID, window: "1w" } });
    await fails(server("getIngestMetrics"), "outsider", "Forbidden", { params: { id: OWN_ID } });
    expect(await provisioner.requests()).toEqual([]);
  });
});

describe("the metrics codes pass through with the provisioner's words", () => {
  const CODES = [
    [503, "MetricsUnavailable", "This instance isn't running."],
    [504, "MetricsTimeout", "The instance took too long to answer."],
    [409, "NotSupported", "This instance's HappyView is too old to report metrics."],
    [400, "InvalidRequest", "the last day is kept by the half hour: use step=30m with window=24h"],
  ] as const;
  const cases = [
    ["server", server("getScriptMetrics"), "customer", { id: OWN_ID }, `/v1/tenants/${OWN_ID}/metrics/scripts`],
    ["server", server("getIngestMetrics"), "customer", { id: OWN_ID }, `/v1/tenants/${OWN_ID}/metrics/ingest`],
    ["fleet", fleet("getTenantScriptMetrics"), "staff", { tenant: SOMEONE_ELSES_ID, trigger: TRIGGER },
      `/v1/tenants/${SOMEONE_ELSES_ID}/metrics/scripts/${ENCODED}`],
    ["fleet", fleet("getTenantIngestMetrics"), "staff", { tenant: SOMEONE_ELSES_ID },
      `/v1/tenants/${SOMEONE_ELSES_ID}/metrics/ingest`],
  ] as const;
  for (const [, nsid, who, params, path] of cases) {
    test(nsid, async () => {
      for (const [status, code, message] of CODES) {
        await provisioner.script("GET", path, status, { error: code, message });
        const reply = await fails(nsid, who, code, { params: { ...params } });
        expect(reply.body.message).toBe(message);
      }
      // Anything else is Upstream, and never the provisioner's text.
      await provisioner.script("GET", path, 500, { error: "Internal", message: "SENTINEL-internal" });
      const reply = await fails(nsid, who, "Upstream", { params: { ...params } });
      expect(reply.body.message).not.toContain("SENTINEL");
    });
  }
});

describe("fleet.getTenantScriptMetrics and fleet.getTenantIngestMetrics", () => {
  test("staff read any tenant's scripts, list and series", async () => {
    const list = await ok(fleet("getTenantScriptMetrics"), "staff", { params: { tenant: SOMEONE_ELSES_ID } });
    expect(list).toEqual({ window: "1h", enabled: true, scripts: SCRIPTS });
    const series = await ok(fleet("getTenantScriptMetrics"), "staff", {
      params: { tenant: SOMEONE_ELSES_ID, trigger: TRIGGER, window: "30d", step: "1d" },
    });
    expect(series).toEqual({ ...SERIES, window: "30d", step: "1d", retentionDays: 30 });
    const sent = await metricReads();
    expect(sent.map((r) => r.path)).toEqual([
      `/v1/tenants/${SOMEONE_ELSES_ID}/metrics/scripts`,
      `/v1/tenants/${SOMEONE_ELSES_ID}/metrics/scripts/${ENCODED}`,
    ]);
    expect(sent[1].query).toEqual({ window: "30d", step: "1d" });
    expect(sent[1].headers["x-actor-did"]).toBe(s.accounts.staff.did);
  });

  test("staff read any tenant's ingest", async () => {
    const out = await ok(fleet("getTenantIngestMetrics"), "staff", { params: { tenant: SOMEONE_ELSES_ID, window: "7d" } });
    expect(out).toEqual({ window: "7d", enabled: true, retentionDays: 30, collections: COLLECTIONS });
  });

  test("a tenant that does not exist is NotFound", async () => {
    await fails(fleet("getTenantIngestMetrics"), "staff", "NotFound", {
      params: { tenant: "88888888-8888-4888-8888-888888888888" },
    });
  });

  test("a bad tenant, window, step or trigger is InvalidRequest before anything is read", async () => {
    const bad: Record<string, string>[] = [
      { tenant: "../plans" },
      { tenant: OWN_ID, window: "2h" },
      { tenant: OWN_ID, trigger: TRIGGER, step: "5m" },
      { tenant: OWN_ID, trigger: "../x" },
      { tenant: OWN_ID, trigger: "a/b" },
      { tenant: OWN_ID, trigger: "a".repeat(301) },
    ];
    for (const params of bad) {
      await fails(fleet("getTenantScriptMetrics"), "staff", "InvalidRequest", { params });
    }
    await fails(fleet("getTenantIngestMetrics"), "staff", "InvalidRequest", { params: { tenant: OWN_ID, window: "2h" } });
    expect(await provisioner.requests()).toEqual([]);
  });

  test("customers and outsiders are refused, even for their own tenant", async () => {
    for (const name of ["getTenantScriptMetrics", "getTenantIngestMetrics"]) {
      await fails(fleet(name), "customer", "Forbidden", { params: { tenant: OWN_ID } });
      await fails(fleet(name), "outsider", "Forbidden", { params: { tenant: OWN_ID } });
      await fails(fleet(name), null, "AuthRequired", { params: { tenant: OWN_ID } });
    }
    expect(await provisioner.requests()).toEqual([]);
  });
});
