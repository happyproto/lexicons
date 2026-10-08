/**
 * The fleet dashboard's endpoints, and actor.getProfile, on a real HappyView
 * v3 with the fake ClickHouse serving canned rows.
 *
 * Each staff call is validated against its lexicon's output schema (see
 * xrpc.ts), so a conversion that renames, drops or mistypes a field fails
 * here. The canned rows populate every array, so item shapes are checked
 * too, not just an empty list.
 *
 * Counts arrive as strings, the way ClickHouse's JSON format sends 64-bit
 * integers. Timestamps are ISO 8601, which is what the lexicons demand.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clickhouse } from "./fakes";
import { setVariable, stack } from "./setup";
import { call, fails, ok } from "./xrpc";

beforeAll(async () => {
  await stack();
}, 180_000);

beforeEach(async () => {
  await clickhouse.reset();
});

const fleet = (name: string) => `at.happyproto.fleet.${name}`;

const FLEET = [
  "getAdoption",
  "getBenchmarks",
  "getCostShape",
  "getGrowth",
  "getHostMix",
  "getIngestHealth",
  "getLexiconShape",
  "getResets",
  "getRetention",
  "getSignals",
  "getVersions",
  "listInstances",
];

describe("every fleet endpoint refuses anyone outside the admin space", () => {
  for (const name of FLEET) {
    test(name, async () => {
      const params = name === "getBenchmarks" ? { instance: "inst-1" } : undefined;
      await fails(fleet(name), "outsider", "Forbidden", { params });
      // Being a customer does not make someone staff.
      await fails(fleet(name), "customer", "Forbidden", { params });
      await fails(fleet(name), null, "AuthRequired", { params });
      // Refused before any query runs.
      expect(await clickhouse.queries()).toEqual([]);
    });
  }
});

describe("fleet endpoints as staff", () => {
  test("getAdoption", async () => {
    await clickhouse.rows("count(DISTINCT instance_id) AS instances", [{ instances: "3" }]);
    await clickhouse.rows("ARRAY JOIN arrayDistinct", [
      { feature: "spaces", ever_used: "2", active_now: "1", built_not_used: "1" },
      { feature: "labelers", ever_used: "1", active_now: "1", built_not_used: "0" },
    ]);
    const out = await ok(fleet("getAdoption"), "staff");
    expect(out.status).toBe("ok");
    expect(out.instances).toBe(3);
    expect(out.features[0]).toEqual({ feature: "spaces", everUsed: 2, activeNow: 1, builtNotUsed: 1 });
  });

  test("getAdoption while accruing", async () => {
    const out = await ok(fleet("getAdoption"), "staff");
    expect(out).toMatchObject({ status: "accruing", features: [] });
  });

  test("getBenchmarks", async () => {
    await clickhouse.rows("WHERE instance_id = {instance:String}", [
      { cohort: "1e3", records: 1500, database_bytes: 3000000, event_logs: 40, rss_anon: 90000000 },
    ]);
    await clickhouse.rows("FROM fleet_benchmarks", [
      {
        metric: "level:records",
        cohort_size: "12",
        p50: 1000,
        quantiles: [100, 500, 1000, 2000],
        computed_at: "2026-10-07T00:00:00.000Z",
      },
    ]);
    const out = await ok(fleet("getBenchmarks"), "staff", { params: { instance: "inst-1" } });
    expect(out).toMatchObject({ status: "ok", cohort: "1e3", cohortSize: 12 });
    expect(out.metrics).toEqual([{ metric: "level:records", value: 1500, p50: 1000, percentile: 75 }]);
    // The instance travels as a ClickHouse parameter, never in the SQL.
    const [first] = await clickhouse.queries();
    expect(first.params).toEqual({ param_instance: "inst-1" });
    expect(first.sql).not.toContain("inst-1");
  });

  test("getBenchmarks without an instance, and for an unknown one", async () => {
    await fails(fleet("getBenchmarks"), "staff", "InvalidRequest");
    await fails(fleet("getBenchmarks"), "staff", "NotFound", { params: { instance: "nope" } });
  });

  test("getCostShape", async () => {
    await clickhouse.rows("FROM resolved", [
      {
        instances: "4",
        bpr_instances: "3",
        bpr_p50: 120,
        bpr_p90: 300,
        disk_p50: 1000000,
        disk_p90: 5000000,
        disk_instances: "4",
        anon_p50: 80000000,
        anon_p90: 150000000,
        anon_instances: "4",
        file_p50: 0,
        file_p90: 0,
        file_instances: "0",
        any_disk_host: 1,
        any_disk_totals: 1,
        any_anon_host: 0,
        any_anon_totals: 1,
        any_file: 0,
      },
    ]);
    const out = await ok(fleet("getCostShape"), "staff");
    expect(out).toMatchObject({
      status: "ok",
      instances: 4,
      bytesPerRecord: { p50: 120, p90: 300, instances: 3 },
      sources: { diskBytes: "host", memoryAnon: "totals", memoryFile: "none" },
    });
  });

  test("getGrowth", async () => {
    await clickhouse.rows("count(DISTINCT toDate(ts)) AS days", [{ days: "5" }]);
    await clickhouse.rows("AS per_day", [{ metric: "records", per_day: 12 }]);
    await clickhouse.rows("avg(delta) AS rate", [{ instance_id: "inst-1", metric: "records", rate: 3 }]);
    const out = await ok(fleet("getGrowth"), "staff");
    expect(out.fleet).toEqual([{ metric: "records", perDay: 12 }]);
    expect(out.byInstance).toEqual([{ instanceId: "inst-1", metric: "records", rate: 3 }]);
  });

  test("getHostMix", async () => {
    await clickhouse.rows("AS sharing", [{ total: "3", sharing: "2" }]);
    await clickhouse.rows("INNER JOIN classified", [{ key: "os", value: "linux", instances: "2" }]);
    await clickhouse.rows("WHERE NOT categorical", [{ key: "kernel", distinct_values: "3" }]);
    const out = await ok(fleet("getHostMix"), "staff");
    expect(out).toEqual({
      status: "ok",
      coverage: { sharing: 2, of: 3 },
      facts: [{ key: "os", value: "linux", instances: 2 }],
      varying: [{ key: "kernel", distinctValues: 3 }],
    });
  });

  test("getIngestHealth", async () => {
    await clickhouse.rows("AS worst", [{ snapshots: "10", p50: 1, p90: 4, worst: 9 }]);
    await clickhouse.rows("AS ahead", [{ instance_id: "inst-2", ahead: 30 }]);
    await clickhouse.rows("argMax(schema_version, ts)", [{ schema_version: 2, instances: "3" }]);
    const out = await ok(fleet("getIngestHealth"), "staff");
    expect(out.lag).toEqual({ p50: 1, p90: 4, max: 9 });
    expect(out.skewed).toEqual([{ instanceId: "inst-2", aheadSeconds: 30 }]);
    expect(out.schemaVersions).toEqual([{ version: 2, instances: 3 }]);
  });

  test("getLexiconShape", async () => {
    await clickhouse.rows("AS top_share_p90", [
      { total: "3", with_shares: "2", count_p50: 4, count_p90: 9, top_share_p50: 60, top_share_p90: 90 },
    ]);
    const out = await ok(fleet("getLexiconShape"), "staff");
    expect(out).toEqual({
      status: "ok",
      instances: 3,
      lexiconCount: { p50: 4, p90: 9 },
      topCollectionShare: { p50: 60, p90: 90 },
      coverage: { sharing: 2, of: 3 },
    });
  });

  test("getResets", async () => {
    await clickhouse.rows("count(DISTINCT toDate(ts)) AS days", [{ days: "5" }]);
    await clickhouse.rows("FROM instance_daily_resets", [
      { instance_id: "inst-1", day_text: "2026-10-05", metric: "records", from_value: 100, to_value: 0 },
    ]);
    const out = await ok(fleet("getResets"), "staff");
    expect(out.resets).toEqual([
      { instanceId: "inst-1", day: "2026-10-05", metric: "records", from: 100, to: 0 },
    ]);
  });

  test("getRetention", async () => {
    await clickhouse.rows("AS eligible_90", [
      {
        cohort: "2026-07-01",
        started: "3",
        survived_30: "2",
        survived_60: "2",
        survived_90: "1",
        eligible_30: "3",
        eligible_60: "3",
        eligible_90: "2",
      },
    ]);
    const out = await ok(fleet("getRetention"), "staff");
    expect(out.status).toBe("ok");
    expect(out.cohorts[0]).toMatchObject({ cohort: "2026-07-01", started: 3, survived90: 1 });
  });

  test("getSignals", async () => {
    await clickhouse.rows("countIf(t['events.script.error'] > 0)", [
      { n1: "2", s1: "7", n2: "0", s2: "0", n3: "0", s3: "0", n4: "1", s4: "3", n5: "0", s5: "0", n6: "0", s6: "0", instances: "4" },
    ]);
    await clickhouse.rows("HAVING last_seen <", [
      { instance_id: "inst-1", last_seen: "2026-10-01T00:00:00.000Z" },
    ]);
    await clickhouse.rows("AS dormant", [{ active: "3", quiet: "1", dormant: "0", total: "4" }]);
    const out = await ok(fleet("getSignals"), "staff");
    expect(out.instances).toEqual({ active: 3, quiet: 1, dormant: 0, total: 4 });
    expect(out.signals.map((s: { key: string }) => s.key)).toEqual([
      "events.script.error",
      "events.job.failed",
    ]);
    expect(out.quiet).toEqual([{ instanceId: "inst-1", lastSeen: "2026-10-01T00:00:00.000Z" }]);
  });

  test("getSignals with an empty store returns empty arrays, not objects", async () => {
    const out = await ok(fleet("getSignals"), "staff");
    expect(out).toEqual({
      instances: { active: 0, quiet: 0, dormant: 0, total: 0 },
      signals: [],
      quiet: [],
    });
  });

  test("getVersions", async () => {
    await clickhouse.rows("fleet_first_seen", [
      { version: "3.0.0", instances: "3", first_seen: "2026-09-01T00:00:00.000Z", median_days: 2, adopters: "3" },
      { version: "2.14.0", instances: "1", first_seen: "2026-06-01T00:00:00.000Z", median_days: 5, adopters: "4" },
    ]);
    const out = await ok(fleet("getVersions"), "staff");
    expect(out.status).toBe("ok");
    expect(out.versions[0]).toEqual({
      version: "3.0.0",
      instances: 3,
      firstSeen: "2026-09-01T00:00:00.000Z",
      medianDaysToAdopt: 2,
      adopters: 3,
    });
  });

  test("listInstances", async () => {
    await clickhouse.rows("AS script_errors", [
      {
        instance_id: "inst-1",
        last_seen: "2026-10-07T12:00:00.000Z",
        version: "3.0.0",
        report_mode: "auto",
        records: "1500",
        users: "4",
        spaces: "1",
        lexicons: "12",
        script_errors: "0",
      },
    ]);
    await clickhouse.rows("AS with_host", [
      { total: "1", with_contact: "1", with_lexicon_names: "0", with_host: "1" },
    ]);
    const out = await ok(fleet("listInstances"), "staff");
    expect(out.instances[0]).toMatchObject({ instanceId: "inst-1", records: 1500, reportMode: "auto" });
    expect(out.consent).toEqual({ total: 1, withContact: 1, withLexiconNames: 0, withHost: 1 });
  });

  test("a ClickHouse failure is Upstream, not a 500", async () => {
    // The fake refuses a wrong password the way ClickHouse does.
    const { apiKey, variables } = await stack();
    await setVariable(apiKey, "HAPPYPROTO_CLICKHOUSE_PASSWORD", "wrong");
    try {
      await fails(fleet("getSignals"), "staff", "Upstream");
    } finally {
      await setVariable(apiKey, "HAPPYPROTO_CLICKHOUSE_PASSWORD", variables.HAPPYPROTO_CLICKHOUSE_PASSWORD);
    }
  });
});

describe("actor.getProfile", () => {
  const nsid = "at.happyproto.actor.getProfile";

  test("staff are members, with their access level", async () => {
    const { accounts } = await stack();
    const out = await ok(nsid, "staff");
    expect(out).toMatchObject({ did: accounts.staff.did, isSelf: true, isMember: true, access: "read" });
  });

  test("an outsider is told they are not a member, and gets no access field", async () => {
    const { accounts } = await stack();
    const out = await ok(nsid, "outsider");
    expect(out).toMatchObject({ did: accounts.outsider.did, isSelf: true, isMember: false });
    expect(out).not.toHaveProperty("access");
  });

  test("anonymous callers are refused", async () => {
    await fails(nsid, null, "AuthRequired");
  });

  test("another actor is ActorNotFound when their profile cannot be fetched", async () => {
    // The stack's PDS will not serve app.bsky.actor.getProfile to the
    // credential-less proxy, so this is the path every non-self lookup takes
    // here. It must refuse legibly, never invent a profile or entitlements.
    const { accounts } = await stack();
    const reply = await fails(nsid, "outsider", "ActorNotFound", {
      params: { actor: accounts.staff.did },
    });
    expect(reply.body).not.toHaveProperty("isMember");
  });
});
