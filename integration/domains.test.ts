/**
 * The customer custom-domain endpoints -- listDomains, addDomain, checkDomain
 * and removeDomain -- on a real HappyView v3 against the fake provisioner.
 *
 * Every endpoint checks ownership with GET /v1/tenants/:id before it calls a
 * domain route, because the provisioner lets staff reach any tenant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner, type ProvisionerRequest } from "./fakes";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const server = (name: string) => `at.happyproto.server.${name}`;

const MINE = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSES = "44444444-4444-4444-8444-444444444444";
const VERIFIED = "d0000000-0000-4000-8000-000000000001";
const PRIMARY = "d0000000-0000-4000-8000-000000000002";
const JOB_TIMEOUT = 90_000;

function tenant(id: string, slug: string, owner: string) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: "99999999-9999-4999-8999-999999999999",
    happyview_version: "3.0.0-alpha.4",
    public_url: `https://${slug}.hpy.at`,
    image: "ghcr.io/happyproto/happyview-network-store",
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

/** A domain row as the fake stores it. */
function domain(id: string, hostname: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: MINE,
    hostname,
    state: "verified",
    primary: false,
    records: [
      { type: "TXT", name: `_happyproto.${hostname}`, value: "happyproto-verify=abc" },
      { type: "CNAME", name: hostname, value: "alpha.hpy.at" },
    ],
    checks: { ownership: "ok", pointing: "ok", checkedAt: "2026-10-28T12:00:00Z" },
    serving: "live",
    lapsesAt: null,
    expiresAt: null,
    createdAt: "2026-10-28T11:00:00Z",
    verifiedAt: "2026-10-28T11:02:00Z",
    ...extra,
  };
}

async function sent(): Promise<ProvisionerRequest[]> {
  return (await provisioner.requests()).filter(
    (r) => !(r.method === "GET" && r.path.startsWith("/v1/operations/")),
  );
}

const started: string[] = [];
let s: Stack;

beforeAll(async () => {
  s = await stack();
}, 180_000);

beforeEach(async () => {
  await provisioner.reset();
  await provisioner.state({
    customDomains: true,
    tenants: [tenant(MINE, "alpha", s.accounts.customer.did), tenant(SOMEONE_ELSES, "gamma", "did:plc:someoneelseentirely")],
  });
});

afterAll(async () => {
  // Leave the job worker idle for whatever runs next.
  const deadline = Date.now() + JOB_TIMEOUT;
  for (const id of started) {
    while (Date.now() < deadline) {
      const { job } = await ok(server("getJob"), "customer", { params: { id } });
      if (["completed", "failed", "cancelled", "paused"].includes(job.status)) break;
      await Bun.sleep(250);
    }
  }
}, JOB_TIMEOUT + 10_000);

describe("server.listDomains", () => {
  test("lists the platform subdomain as primary and no custom domain yet", async () => {
    const out = await ok(server("listDomains"), "customer", { params: { instanceId: MINE } });
    expect(out).toEqual({ platform: { hostname: "alpha.hpy.at", primary: true }, domains: [] });
  });

  test("answers NotAvailable while custom domains are switched off", async () => {
    await provisioner.state({ customDomains: false });
    await fails(server("listDomains"), "customer", "NotAvailable", { params: { instanceId: MINE } });
  });

  test("another customer's instance is NotFound, and no domain route is called", async () => {
    await fails(server("listDomains"), "customer", "NotFound", { params: { instanceId: SOMEONE_ELSES } });
    expect((await sent()).map((r) => r.path)).toEqual([`/v1/tenants/${SOMEONE_ELSES}`]);
  });

  test("passes only the fields it lists", async () => {
    await provisioner.script("GET", `/v1/tenants/${MINE}/domains`, 200, {
      platform: { hostname: "alpha.hpy.at", primary: false, internal: "x" },
      domains: [{ ...domain(VERIFIED, "app.example.com"), token: "SENTINEL-token", tenant_id: MINE }],
    });
    const out = await ok(server("listDomains"), "customer", { params: { instanceId: MINE } });
    expect(JSON.stringify(out)).not.toContain("SENTINEL");
    expect(JSON.stringify(out)).not.toContain("tenant_id");
    expect(out.platform).toEqual({ hostname: "alpha.hpy.at", primary: false });
    expect(out.domains[0]).toMatchObject({ hostname: "app.example.com", state: "verified", serving: "live" });
  });
});

test("a check that never got to the CNAME leaves pointing out", async () => {
  await provisioner.state({
    domains: [
      domain(VERIFIED, "app.example.com", {
        state: "pending",
        checks: { ownership: "missing", pointing: null, checkedAt: "2026-10-28T12:00:00Z" },
      }),
    ],
  });
  const out = await ok(server("listDomains"), "customer", { params: { instanceId: MINE } });
  expect(out.domains[0].checks).toEqual({ ownership: "missing", checkedAt: "2026-10-28T12:00:00Z" });
});

describe("server.addDomain", () => {
  test("adds a pending domain with its records, as the caller, with their key", async () => {
    const key = crypto.randomUUID();
    const out = await ok(server("addDomain"), "customer", {
      input: { instanceId: MINE, hostname: "App.Example.com", idempotencyKey: key },
    });
    expect(out.domain).toMatchObject({ hostname: "app.example.com", state: "pending", primary: false, serving: "off" });
    expect("checks" in out.domain).toBe(false);
    expect(out.domain.records[0]).toMatchObject({ type: "TXT", name: "_happyproto.app.example.com" });
    expect(out.domain.records[0].value).toMatch(/^happyproto-verify=/);
    expect(out.domain.records[1]).toMatchObject({ type: "CNAME", value: "alpha.hpy.at", alt: { type: "A" } });

    const [owner, add, ...rest] = await sent();
    expect(rest).toEqual([]);
    expect(owner.path).toBe(`/v1/tenants/${MINE}`);
    expect(add).toMatchObject({ method: "POST", path: `/v1/tenants/${MINE}/domains`, body: { hostname: "App.Example.com" } });
    expect(add.headers["idempotency-key"]).toBe(key);

    const listed = await ok(server("listDomains"), "customer", { params: { instanceId: MINE } });
    expect(listed.domains.map((d: any) => d.id)).toEqual([out.domain.id]);
  });

  test("a second domain is DomainLimit", async () => {
    await provisioner.state({ domains: [domain(VERIFIED, "app.example.com")] });
    await fails(server("addDomain"), "customer", "DomainLimit", {
      input: { instanceId: MINE, hostname: "other.example.com", idempotencyKey: crypto.randomUUID() },
    });
  });

  test("a platform name is PlatformHostname, and a non-hostname is InvalidHostname", async () => {
    await fails(server("addDomain"), "customer", "PlatformHostname", {
      input: { instanceId: MINE, hostname: "beta.hpy.at", idempotencyKey: crypto.randomUUID() },
    });
    await fails(server("addDomain"), "customer", "InvalidHostname", {
      input: { instanceId: MINE, hostname: "not a hostname", idempotencyKey: crypto.randomUUID() },
    });
  });

  test("checks its own input before calling the provisioner", async () => {
    await fails(server("addDomain"), "customer", "InvalidRequest", {
      input: { instanceId: MINE, hostname: "", idempotencyKey: crypto.randomUUID() },
    });
    await fails(server("addDomain"), "customer", "InvalidRequest", {
      input: { instanceId: "nope", hostname: "app.example.com", idempotencyKey: crypto.randomUUID() },
    });
    expect(await sent()).toEqual([]);
  });

  test("another customer's instance is NotFound, and nothing is added", async () => {
    await fails(server("addDomain"), "customer", "NotFound", {
      input: { instanceId: SOMEONE_ELSES, hostname: "app.example.com", idempotencyKey: crypto.randomUUID() },
    });
    expect((await sent()).filter((r) => r.method !== "GET")).toEqual([]);
  });

  test("a provisioner failure it does not explain is Upstream", async () => {
    await provisioner.script("POST", `/v1/tenants/${MINE}/domains`, 500, { error: "Internal", message: "SENTINEL-db" });
    const reply = await fails(server("addDomain"), "customer", "Upstream", {
      input: { instanceId: MINE, hostname: "app.example.com", idempotencyKey: crypto.randomUUID() },
    });
    expect(reply.text).not.toContain("SENTINEL");
  });
});

describe("server.checkDomain", () => {
  test("runs a check now, and a second within seconds is TooSoon", async () => {
    await provisioner.state({ domains: [domain(VERIFIED, "app.example.com", { state: "pending", checks: null })] });
    const input = () => ({ instanceId: MINE, domainId: VERIFIED, idempotencyKey: crypto.randomUUID() });
    const out = await ok(server("checkDomain"), "customer", { input: input() });
    expect(out.domain.checks).toMatchObject({ ownership: "missing", pointing: "error" });
    await fails(server("checkDomain"), "customer", "TooSoon", { input: input() });
  });

  test("an unknown domain is NotFound", async () => {
    await fails(server("checkDomain"), "customer", "NotFound", {
      input: { instanceId: MINE, domainId: VERIFIED, idempotencyKey: crypto.randomUUID() },
    });
  });
});

describe("server.removeDomain", () => {
  test("a domain nothing routed yet is removed with no job", async () => {
    await provisioner.state({ domains: [domain(VERIFIED, "app.example.com", { state: "pending" })] });
    const out = await ok(server("removeDomain"), "customer", {
      input: { instanceId: MINE, domainId: VERIFIED, idempotencyKey: crypto.randomUUID() },
    });
    expect(out).toEqual({});
    const listed = await ok(server("listDomains"), "customer", { params: { instanceId: MINE } });
    expect(listed.domains).toEqual([]);
  });

  test("a verified domain is removed with a job following the routing change", async () => {
    await provisioner.state({ domains: [domain(VERIFIED, "app.example.com")] });
    const out = await ok(server("removeDomain"), "customer", {
      input: { instanceId: MINE, domainId: VERIFIED, idempotencyKey: crypto.randomUUID() },
    });
    expect(typeof out.jobId).toBe("string");
    started.push(out.jobId);
  });

  test("the primary domain is DomainIsPrimary, and stays", async () => {
    await provisioner.state({ domains: [domain(PRIMARY, "app.example.com", { primary: true })] });
    await fails(server("removeDomain"), "customer", "DomainIsPrimary", {
      input: { instanceId: MINE, domainId: PRIMARY, idempotencyKey: crypto.randomUUID() },
    });
    const listed = await ok(server("listDomains"), "customer", { params: { instanceId: MINE } });
    expect(listed.domains.map((d: any) => d.id)).toEqual([PRIMARY]);
  });
});
