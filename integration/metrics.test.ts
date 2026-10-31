/**
 * server.getMetrics on a real HappyView v3, against the fake provisioner.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const server = (name: string) => `at.happyproto.server.${name}`;

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "44444444-4444-4444-8444-444444444444";
const TRIGGER = "record.create:app.bsky.feed.post";

function tenant(id: string, slug: string, owner: string) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: "99999999-9999-4999-8999-999999999999",
    happyview_version: "3.0.0-alpha.46",
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

const SCRIPTS = {
  window: "24h",
  enabled: true,
  overflow: 0,
  scripts: [{ trigger: TRIGGER, kind: "record_event", runs: 12, outcomes: { ok: 11, runtime: 1 }, instructions_mean: null }],
};

let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  const { customer, staff } = s.accounts;
  await provisioner.state({
    staff: [staff.did],
    tenants: [tenant(MINE, "alpha", customer.did), tenant(THEIRS, "gamma", "did:plc:someoneelseentirely")],
    metrics: { [MINE]: { scripts: SCRIPTS } },
  });
});

describe("server.getMetrics", () => {
  test("returns HappyView's report untouched, under the view asked for", async () => {
    const out = await ok(server("getMetrics"), "customer", { params: { id: MINE, view: "scripts", window: "24h" } });
    expect(out).toEqual({ view: "scripts", metrics: SCRIPTS });
    const asked = (await provisioner.requests()).find((r: any) => r.path.includes("/metrics/"));
    expect(asked.path).toBe(`/v1/tenants/${MINE}/metrics/scripts`);
    expect(asked.query).toEqual({ window: "24h" });
  });

  test("one script is asked for by its trigger, encoded", async () => {
    await ok(server("getMetrics"), "customer", { params: { id: MINE, view: "script", trigger: TRIGGER } });
    const asked = (await provisioner.requests()).find((r: any) => r.path.includes("/metrics/"));
    expect(asked.path).toBe(`/v1/tenants/${MINE}/metrics/script`);
    expect(asked.query).toEqual({ trigger: TRIGGER });
  });

  test("bad input is refused locally, and nothing is sent", async () => {
    for (const params of [
      { id: "alpha", view: "scripts" },
      { id: MINE },
      { id: MINE, view: "hooks" },
      { id: MINE, view: "scripts", window: "1y" },
      { id: MINE, view: "script" },
      { id: MINE, view: "script", trigger: "has spaces" },
      { id: MINE, view: "script", trigger: "record:app.bsky.feed.post" },
      { id: MINE, view: "script", trigger: "xrpc.query:a b" },
      { id: MINE, view: "script", trigger: `xrpc.query:${"a".repeat(318)}` },
      { id: MINE, view: "scripts", trigger: TRIGGER },
    ]) {
      await fails(server("getMetrics"), "customer", "InvalidRequest", { params });
    }
    expect(await provisioner.requests()).toEqual([]);
  });

  test("someone else's instance is NotFound, and its metrics are never asked for", async () => {
    await fails(server("getMetrics"), "customer", "NotFound", { params: { id: THEIRS, view: "scripts" } });
    const asked = (await provisioner.requests()).map((r: any) => r.path);
    expect(asked.some((p: string) => p.includes("/metrics/"))).toBe(false);
  });

  test("the relay's metrics codes pass through with its words", async () => {
    for (const [status, code, view] of [
      [503, "MetricsUnavailable", "scripts"],
      [504, "MetricsTimeout", "scripts"],
      [404, "NoRuns", "script"],
    ] as const) {
      await provisioner.script("GET", `/v1/tenants/${MINE}/metrics/${view}`, status, {
        error: code,
        message: `${code} words`,
      });
      const params = view === "script" ? { id: MINE, view, trigger: TRIGGER } : { id: MINE, view };
      const reply = await fails(server("getMetrics"), "customer", code, { params });
      expect(JSON.stringify(reply.body)).toContain(`${code} words`);
    }
  });

  test("an empty list stays a list", async () => {
    await provisioner.state({ metrics: { [MINE]: { ingest: { window: "1h", enabled: false, collections: [] } } } });
    const out = await ok(server("getMetrics"), "customer", { params: { id: MINE, view: "ingest" } });
    expect(out.metrics.collections).toEqual([]);
  });

  test("anyone but a customer is refused before anything is sent", async () => {
    await fails(server("getMetrics"), null, "AuthRequired", { params: { id: MINE, view: "scripts" } });
    expect(await provisioner.requests()).toEqual([]);
  });
});
