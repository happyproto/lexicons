/**
 * An instance's encryption key: where it is in a rotation, starting one,
 * and the key stage on the staff instance list. Staff only. The fake
 * provisioner answers with the key routes' shapes; a seeded `blocked_by`
 * stands in for the checks the real one makes against the instance and its
 * agent.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisioner } from "./fakes";
import { ensureTestUser } from "./session";
import { stack, type Stack } from "./setup";
import { fails, ok } from "./xrpc";

const admin = (name: string) => `at.happyproto.admin.${name}`;

const HOST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAIN_ID = "e0000000-0000-4000-8000-000000000001";
const SEALING_ID = "e0000000-0000-4000-8000-000000000002";
const MISSING_ID = "e0000000-0000-4000-8000-0000000000ff";
const key = () => crypto.randomUUID();

function tenant(id: string, slug: string, owner: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug,
    owner_did: owner,
    plan_id: "small",
    host_id: HOST,
    happyview_version: "3.0.0-alpha.58",
    public_url: `https://${slug}.hpy.at`,
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

let s: Stack;

async function seed(extra: { encryptionKeys?: Record<string, any> } = {}): Promise<void> {
  await provisioner.reset();
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
        last_seen_at: "2026-10-08T09:00:00Z",
        failed_contacts: 0,
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    tenants: [
      tenant(PLAIN_ID, "plain", s.accounts.customer.did, { encryption_stage: "none" }),
      tenant(SEALING_ID, "sealing", s.accounts.customer.did, { encryption_stage: "sealing" }),
    ],
    encryptionKeys: {
      [SEALING_ID]: {
        stage: "sealing",
        rotated_at: "2026-11-02T18:00:00Z",
        sealing: { previous_key_live: true, remaining: 12, unreadable: 1 },
        blocked_by: "RotationInProgress",
      },
    },
    ...extra,
  });
}

beforeAll(async () => {
  s = await stack();
  await ensureTestUser(s.accounts.staff.did, true);
}, 180_000);

beforeEach(() => seed());

describe("refusals", () => {
  const calls: [string, { params?: Record<string, string>; input?: unknown }][] = [
    ["getEncryptionKey", { params: { id: PLAIN_ID } }],
    ["rotateEncryptionKey", { input: { id: PLAIN_ID, idempotencyKey: key() } }],
  ];
  for (const [name, options] of calls) {
    test(`${name} is Forbidden to a customer and an outsider, and sends nothing`, async () => {
      await fails(admin(name), "customer", "Forbidden", options);
      await fails(admin(name), "outsider", "Forbidden", options);
      expect(await provisioner.requests()).toEqual([]);
    });
  }

  test("an id that is not a UUID is InvalidRequest, and sends nothing", async () => {
    await fails(admin("getEncryptionKey"), "staff", "InvalidRequest", { params: { id: "plain" } });
    await fails(admin("rotateEncryptionKey"), "staff", "InvalidRequest", {
      input: { id: "../hosts", idempotencyKey: key() },
    });
    await fails(admin("rotateEncryptionKey"), "staff", "InvalidRequest", {
      input: { id: PLAIN_ID, idempotencyKey: "again" },
    });
    expect(await provisioner.requests()).toEqual([]);
  });
});

describe("admin.getEncryptionKey", () => {
  test("one key: nothing in progress, and a rotation can start", async () => {
    expect(await ok(admin("getEncryptionKey"), "staff", { params: { id: PLAIN_ID } })).toEqual({
      encryptionKey: { stage: "none", canRotate: true },
    });
    const [sent] = await provisioner.requests();
    expect(sent.method).toBe("GET");
    expect(sent.path).toBe(`/v1/tenants/${PLAIN_ID}/encryption-key`);
  });

  test("part-way: the counts, when it rotated, and why another cannot start", async () => {
    expect(await ok(admin("getEncryptionKey"), "staff", { params: { id: SEALING_ID } })).toEqual({
      encryptionKey: {
        stage: "sealing",
        rotatedAt: "2026-11-02T18:00:00Z",
        sealing: { previousKeyLive: true, remaining: 12, unreadable: 1 },
        canRotate: false,
        blockedBy: "RotationInProgress",
      },
    });
  });

  test("no counts when the host did not answer, rather than zeros", async () => {
    await seed({
      encryptionKeys: { [SEALING_ID]: { stage: "sealing", sealing: null, blocked_by: "AgentUnreachable" } },
    });
    const { encryptionKey } = await ok(admin("getEncryptionKey"), "staff", { params: { id: SEALING_ID } });
    expect(encryptionKey.sealing).toBeUndefined();
    expect(encryptionKey.blockedBy).toBe("AgentUnreachable");
  });

  test("says when the instance isn't running with both keys, so a 0 isn't read as done", async () => {
    await seed({
      encryptionKeys: {
        [SEALING_ID]: {
          stage: "sealing",
          sealing: { previous_key_live: false, remaining: 0, unreadable: 0 },
          blocked_by: "RotationInProgress",
        },
      },
    });
    const { encryptionKey } = await ok(admin("getEncryptionKey"), "staff", { params: { id: SEALING_ID } });
    expect(encryptionKey.sealing).toEqual({ previousKeyLive: false, remaining: 0, unreadable: 0 });
  });

  test("a failed rotation: the stage, nothing in progress, and NotSettled", async () => {
    const failure = { operation_id: "f0000000-0000-4000-8000-000000000001", kind: "rotate_key", error_code: "StepFailed" };
    await seed({ encryptionKeys: { [SEALING_ID]: { stage: "failed", failure, blocked_by: "NotSettled" } } });
    expect(await ok(admin("getEncryptionKey"), "staff", { params: { id: SEALING_ID } })).toEqual({
      encryptionKey: {
        stage: "failed",
        failure: { operationId: failure.operation_id, kind: "rotate_key", errorCode: "StepFailed" },
        canRotate: false,
        blockedBy: "NotSettled",
      },
    });
  });

  test("a missing instance is NotFound", async () => {
    await fails(admin("getEncryptionKey"), "staff", "NotFound", { params: { id: MISSING_ID } });
  });

  test("an unexplained 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("GET", `/v1/tenants/${PLAIN_ID}/encryption-key`, 500, {
      error: "Internal",
      message: "SENTINEL-key",
    });
    const reply = await fails(admin("getEncryptionKey"), "staff", "Upstream", { params: { id: PLAIN_ID } });
    expect(reply.text).not.toContain("SENTINEL");
  });
});

describe("admin.rotateEncryptionKey", () => {
  test("starts a rotate_key operation, with the key going along", async () => {
    const idempotencyKey = key();
    const { operation } = await ok(admin("rotateEncryptionKey"), "staff", {
      input: { id: PLAIN_ID, idempotencyKey },
    });
    expect(operation).toMatchObject({ kind: "rotate_key", status: "pending" });
    const [sent] = await provisioner.requests();
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe(`/v1/tenants/${PLAIN_ID}/encryption-key/rotate`);
    expect(sent.headers["idempotency-key"]).toBe(idempotencyKey);
  });

  test("a retry with the same key replays the answer and starts nothing new", async () => {
    const idempotencyKey = key();
    const first = await ok(admin("rotateEncryptionKey"), "staff", { input: { id: PLAIN_ID, idempotencyKey } });
    const again = await ok(admin("rotateEncryptionKey"), "staff", { input: { id: PLAIN_ID, idempotencyKey } });
    expect(again.operation.id).toBe(first.operation.id);
  });

  test("each reason a rotation cannot start passes through with its code and words", async () => {
    for (const code of [
      "RotationInProgress",
      "InstanceStopped",
      "NotLive",
      "RotationUnsupported",
      "AgentUnreachable",
      "NotSettled",
    ]) {
      await seed({ encryptionKeys: { [PLAIN_ID]: { stage: "none", blocked_by: code } } });
      const reply = await fails(admin("rotateEncryptionKey"), "staff", code, {
        input: { id: PLAIN_ID, idempotencyKey: key() },
      });
      expect(reply.body.message).toBe(`${code} said`);
    }
  });

  test("a host that didn't answer is AgentUnreachable, though it comes as a 503", async () => {
    await seed({ encryptionKeys: { [PLAIN_ID]: { stage: "none", blocked_by: "AgentUnreachable" } } });
    const reply = await fails(admin("rotateEncryptionKey"), "staff", "AgentUnreachable", {
      input: { id: PLAIN_ID, idempotencyKey: key() },
    });
    expect(reply.body.message).toBe("AgentUnreachable said");
  });

  test("another operation in progress is OperationInProgress", async () => {
    await ok(admin("rotateEncryptionKey"), "staff", { input: { id: PLAIN_ID, idempotencyKey: key() } });
    await fails(admin("rotateEncryptionKey"), "staff", "OperationInProgress", {
      input: { id: PLAIN_ID, idempotencyKey: key() },
    });
  });

  test("a missing instance is NotFound", async () => {
    await fails(admin("rotateEncryptionKey"), "staff", "NotFound", {
      input: { id: MISSING_ID, idempotencyKey: key() },
    });
  });

  test("an unexplained 5xx is Upstream, and its body is never echoed", async () => {
    await provisioner.script("POST", `/v1/tenants/${PLAIN_ID}/encryption-key/rotate`, 500, {
      error: "Internal",
      message: "SENTINEL-rotate",
    });
    const reply = await fails(admin("rotateEncryptionKey"), "staff", "Upstream", {
      input: { id: PLAIN_ID, idempotencyKey: key() },
    });
    expect(reply.text).not.toContain("SENTINEL");
  });
});

describe("admin.listInstances", () => {
  test("each instance carries its key stage", async () => {
    const { instances } = await ok(admin("listInstances"), "staff");
    const stages = Object.fromEntries(instances.map((i: any) => [i.slug, i.encryptionStage]));
    expect(stages).toEqual({ plain: "none", sealing: "sealing" });
  });
});
