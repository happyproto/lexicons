/**
 * admin.getFleet: every host, and every tenant with its plan, owner and
 * latest metered hour, for the staff fleet view (HAP-386). The fake
 * provisioner answers GET /v1/hosts and GET /v1/admin/tenants with
 * api/hosts.rs's and api/fleet.rs's shapes.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { ensureTestUser } from "./session";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const METHOD = "at.happyproto.admin.getFleet";
const HOST = "f0000000-0000-4000-8000-0000000000aa";
const PLACED = "f0000000-0000-4000-8000-000000000001";
const UNPLACED = "f0000000-0000-4000-8000-000000000002";
const NOMAIL = "f0000000-0000-4000-8000-000000000003";

let s: Stack;

function tenant(id: string, slug: string, owner: string, host: string | null) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: host,
    happyview_version: "3.0.0-alpha.59",
    public_url: `https://${slug}.hpy.at`,
    image: "ghcr.io/gamesgamesgamesgamesgames/happyview",
    routed: true,
    desired_state: "running",
    observed_state: "running",
    spec_hash: "sha256:abc",
    created_at: "2026-11-01T12:00:00Z",
    deleted_at: null,
    purge_after: null,
    purged_at: null,
    owner_confirmed_at: "2026-11-01T12:05:00Z",
  };
}

async function seed(): Promise<void> {
  await provisioner.reset();
  const customer = s.accounts.customer.did;
  await provisioner.state({
    staff: [s.accounts.staff.did],
    hosts: [
      {
        id: HOST,
        name: "tenant-1",
        private_addr: "10.0.0.5",
        public_ipv4: "203.0.113.5",
        public_ipv6: null,
        memory_mb: 16384,
        cpu_millis: 8000,
        disk_gb: 200,
        state: "active",
        agent_cert_fingerprint: "f".repeat(64),
        last_seen_at: "2026-11-05T09:00:00Z",
        failed_contacts: 0,
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    tenants: [
      tenant(PLACED, "placed", customer, HOST),
      tenant(UNPLACED, "unplaced", customer, null),
      { ...tenant(NOMAIL, "nomail", "did:plc:nomailowner", HOST), deleted_at: null },
      { ...tenant("f0000000-0000-4000-8000-000000000004", "gone", customer, HOST), deleted_at: "2026-11-02T00:00:00Z" },
    ],
    accountEmails: { [customer]: { email: "owner@example.com", email_confirmed: false } },
    tenantUsage: {
      [PLACED]: {
        hour: "2026-11-05T10:00:00Z",
        disk_avg_bytes: 1_000_000,
        disk_peak_bytes: 1_200_000,
        mem_peak_bytes: 300_000_000,
        mem_avg_bytes: 250_000_000,
        seats: 2,
        api_clients: 1,
        partial: false,
      },
    },
  });
}

beforeAll(async () => {
  s = await stack();
  await ensureTestUser(s.accounts.staff.did, true);
}, 180_000);

beforeEach(() => seed());

describe("admin.getFleet", () => {
  test("is Forbidden to a customer and an outsider, and asks the provisioner nothing", async () => {
    await fails(METHOD, "customer", "Forbidden");
    await fails(METHOD, "outsider", "Forbidden");
    expect(await provisioner.requests()).toEqual([]);
  });

  test("hosts, and each live tenant with its plan, owner and latest hour", async () => {
    const { hosts, tenants } = await ok(METHOD, "staff");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: HOST, name: "tenant-1", state: "active", diskGb: 200, tenantCount: 2 });
    expect(hosts[0]).not.toHaveProperty("agentCertFingerprint");
    expect(hosts[0]).not.toHaveProperty("privateAddr");

    const slugs = tenants.map((t: any) => t.slug).sort();
    expect(slugs).toEqual(["nomail", "placed", "unplaced"]);

    const placed = tenants.find((t: any) => t.slug === "placed");
    expect(placed).toEqual({
      id: PLACED,
      slug: "placed",
      hostId: HOST,
      desiredState: "running",
      observedState: "running",
      version: "3.0.0-alpha.59",
      createdAt: "2026-11-01T12:00:00Z",
      plan: { id: "small", name: "Small", memoryMb: 512, diskGb: 5 },
      owner: { did: s.accounts.customer.did, email: "owner@example.com", emailConfirmed: false },
      usage: {
        hour: "2026-11-05T10:00:00Z",
        diskAvgBytes: 1_000_000,
        diskPeakBytes: 1_200_000,
        memPeakBytes: 300_000_000,
        memAvgBytes: 250_000_000,
        seats: 2,
        apiClients: 1,
        partial: false,
      },
    });
  });

  test("an unplaced, unmetered tenant has no host and no usage, and an owner without email has none", async () => {
    const { tenants } = await ok(METHOD, "staff");
    const unplaced = tenants.find((t: any) => t.slug === "unplaced");
    expect(unplaced.hostId).toBeUndefined();
    expect(unplaced.usage).toBeUndefined();
    const nomail = tenants.find((t: any) => t.slug === "nomail");
    expect(nomail.owner).toEqual({ did: "did:plc:nomailowner" });
  });

  test("an unexplained provisioner failure is Upstream, and its body is never echoed", async () => {
    await provisioner.script("GET", "/v1/admin/tenants", 500, { error: "Internal", message: "SENTINEL-fleet" });
    const reply = await fails(METHOD, "staff", "Upstream");
    expect(reply.text).not.toContain("SENTINEL");
  });
});
