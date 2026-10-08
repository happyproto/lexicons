/**
 * The prelude, executed. Every block is loaded into a real Lua interpreter
 * behind stub modules for what HappyView provides, and small snippets call
 * the helpers and report what they returned.
 *
 * The structure rules prove each script CALLS the gate; these prove the gate
 * does what a gate must, including failing closed on every misconfiguration
 * a live instance can have.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parsePrelude } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

// Same policy as luac in structure.test.ts: a deliberate opt-out is fine, an
// accidental one is not.
const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);


const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
// Every block, in file order: the emit order a script taking all of them gets.
const PRELUDE = [...prelude.values()].join("\n\n");

type Call = {
  fn: string;
  uri?: string;
  did?: string;
  url?: string;
  opts?: any;
  job_type?: string;
  input?: any;
};
type Run = { r1: any; r2: any; log: any[]; calls: Call[] };

const list = (x: unknown) => (Array.isArray(x) ? x : []);

/** Run `snippet` as a function body after the prelude; report what it returned. */
function run(snippet: string): Run {
  if (!lua) {
    // FAIL, do not skip: these are the only tests that execute the gate.
    throw new Error(
      "no lua on PATH, so the prelude was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    PRELUDE,
    `local __out = table.pack((function()\n${snippet}\nend)())`,
    "io.write(__encode({ r1 = __out[1], r2 = __out[2], log = __log, calls = __calls }))",
  ].join("\n\n");

  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const out = JSON.parse(stdout);
  return { r1: out.r1 ?? null, r2: out.r2 ?? null, log: list(out.log), calls: list(out.calls) };
}

const it = skipLua ? test.skip : test;

const TOKEN = "tok-7f3a9c";
const HAPPYPROTO = "did:plc:hp";
const CUSTOMERS = `at://${HAPPYPROTO}/space/at.happyproto.customers/main`;
const ADMINS = `at://${HAPPYPROTO}/space/at.happyproto.admin/main`;
const ENV = `{
  HAPPYPROTO_DID = "${HAPPYPROTO}",
  PROVISIONER_URL = "http://provisioner:8080/",
  PROVISIONER_TOKEN = "${TOKEN}",
  HAPPYPROTO_CLICKHOUSE_URL = "http://clickhouse:8123",
  HAPPYPROTO_CLICKHOUSE_USER = "readonly",
  HAPPYPROTO_CLICKHOUSE_PASSWORD = "pw",
  HAPPYPROTO_CLICKHOUSE_DB = "telemetry",
}`;
const CTX = `{ caller_did = "did:plc:alice", env = ${ENV} }`;

describe("toolchain", () => {
  test("a Lua interpreter is installed", () => {
    if (skipLua) return;
    expect(lua).not.toBeNull();
  });
});

describe("gate", () => {
  it("no caller is AuthRequired", () => {
    for (const caller of ["nil", '""']) {
      const { r1, calls } = run(`return gate_customer({ caller_did = ${caller}, env = ${ENV} })`);
      expect(r1.error).toBe("AuthRequired");
      expect(calls).toEqual([]);
    }
  });

  // Unset, empty, not a DID, and a DID with something after it that would
  // aim the derived uri somewhere else.
  const BAD_DIDS = [
    "{}",
    '{ HAPPYPROTO_DID = "" }',
    '{ HAPPYPROTO_DID = "hp" }',
    '{ HAPPYPROTO_DID = "did:plc:hp/space/x" }',
    "{ HAPPYPROTO_DID = 7 }",
    "nil",
  ];

  it("a missing, empty or malformed HAPPYPROTO_DID is Forbidden, without asking a space", () => {
    for (const env of BAD_DIDS) {
      for (const gate of ["gate_customer", "gate_admin"]) {
        const { r1, calls } = run(`return ${gate}({ caller_did = "did:plc:alice", env = ${env} })`);
        expect([env, gate, r1.error]).toEqual([env, gate, "Forbidden"]);
        expect(calls).toEqual([]);
      }
    }
  });

  it("the old space variables grant nothing on their own", () => {
    const { r1, calls } = run(`return gate_admin({ caller_did = "did:plc:alice", env = {
      HAPPYPROTO_ADMIN_SPACE = "${ADMINS}", HAPPYPROTO_CUSTOMERS_SPACE = "${CUSTOMERS}",
    } })`);
    expect(r1.error).toBe("Forbidden");
    expect(calls).toEqual([]);
  });

  it("a space lookup that raises is Forbidden, not an error", () => {
    const { r1 } = run(`
      __access = function() error("happyview-spaces.access: SPACES_DISABLED") end
      return gate_customer(${CTX})`);
    expect(r1.error).toBe("Forbidden");
    expect(r1.message).not.toContain("SPACES_DISABLED");
  });

  it("no access, or any level not on the allowlist, is Forbidden", () => {
    for (const access of ["nil", '"none"', '""', '"bogus"', "true", "1"]) {
      const { r1 } = run(`
        __access = function() return ${access} end
        return gate_customer(${CTX})`);
      expect(r1).toEqual({ error: "Forbidden", message: "Customers only." });
    }
  });

  it("every allowlisted access level passes", () => {
    for (const access of ["read", "read_self", "write"]) {
      const { r1 } = run(`
        __access = function() return "${access}" end
        return gate_customer(${CTX})`);
      expect([access, r1]).toEqual([access, null]);
    }
  });

  it("read access passes, asking the customers space about the caller", () => {
    const { r1, calls } = run(`
      __access = function() return "read" end
      return gate_customer(${CTX})`);
    expect(r1).toBeNull();
    expect(calls).toEqual([{ fn: "access", uri: CUSTOMERS, did: "did:plc:alice" }]);
  });

  it("gate_admin asks the admin space, and only it", () => {
    const { r1, calls } = run(`
      __access = function(uri) if uri == "${ADMINS}" then return "write" end end
      return gate_admin(${CTX})`);
    expect(r1).toBeNull();
    expect(calls).toEqual([{ fn: "access", uri: ADMINS, did: "did:plc:alice" }]);

    const refused = run(`
      __access = function(uri) if uri == "${CUSTOMERS}" then return "read" end end
      return gate_admin(${CTX})`);
    expect(refused.r1).toEqual({ error: "Forbidden", message: "Admins only." });
  });
});

describe("authority", () => {
  it("derives both spaces from HAPPYPROTO_DID", () => {
    const { r1, r2 } = run(`return happyproto_space(${CTX}, ADMIN_SPACE_TYPE),
      happyproto_space(${CTX}, CUSTOMERS_SPACE_TYPE)`);
    expect([r1, r2]).toEqual([ADMINS, CUSTOMERS]);
  });

  it("a missing, empty or malformed HAPPYPROTO_DID derives nothing", () => {
    for (const env of ["{}", '{ HAPPYPROTO_DID = "" }', '{ HAPPYPROTO_DID = "did:plc:a/b" }', "nil"]) {
      const { r1, r2 } = run(`local ctx = { env = ${env} }
        return happyproto_did(ctx), happyproto_space(ctx, ADMIN_SPACE_TYPE)`);
      expect([env, r1, r2]).toEqual([env, null, null]);
    }
  });
});

describe("gate_owner", () => {
  it("admits exactly HAPPYPROTO_DID, without asking any space", () => {
    const { r1, calls } = run(`return gate_owner({ caller_did = "${HAPPYPROTO}", env = ${ENV} })`);
    expect(r1).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses anyone else and a signed-out caller as Forbidden", () => {
    for (const caller of ['"did:plc:alice"', '"did:plc:hpx"', '""', "nil"]) {
      const { r1, calls } = run(`return gate_owner({ caller_did = ${caller}, env = ${ENV} })`);
      expect([caller, r1?.error]).toEqual([caller, "Forbidden"]);
      expect(calls).toEqual([]);
    }
  });

  it("refuses everyone when HAPPYPROTO_DID is missing, empty or malformed", () => {
    for (const env of ["{}", '{ HAPPYPROTO_DID = "" }', '{ HAPPYPROTO_DID = "hp" }', "nil"]) {
      for (const caller of ['"did:plc:hp"', '"hp"', '""', "nil"]) {
        const { r1 } = run(`return gate_owner({ caller_did = ${caller}, env = ${env} })`);
        expect([env, caller, r1?.error]).toEqual([env, caller, "Forbidden"]);
      }
    }
  });
});

describe("instance_state", () => {
  const state = (tenant: string, op: string) =>
    run(`return instance_state(${tenant}, ${op})`).r1;
  const RUNNING = '{ desired_state = "running", observed_state = "running" }';
  const STOPPED = '{ desired_state = "stopped", observed_state = "stopped" }';
  const BROKEN = '{ desired_state = "running", observed_state = "failed" }';

  it("create pending or running is provisioning, whatever the tenant says", () => {
    for (const status of ["pending", "running"]) {
      expect(state(BROKEN, `{ kind = "create", status = "${status}" }`)).toBe("provisioning");
      expect(state(RUNNING, `{ kind = "create", status = "${status}" }`)).toBe("provisioning");
    }
  });

  it("destroy pending or running is deleting", () => {
    for (const status of ["pending", "running"]) {
      expect(state(RUNNING, `{ kind = "destroy", status = "${status}" }`)).toBe("deleting");
      expect(state(STOPPED, `{ kind = "destroy", status = "${status}" }`)).toBe("deleting");
    }
  });

  it("observed and desired running is running", () => {
    expect(state(RUNNING, "nil")).toBe("running");
    // An operation of another kind, or one that has finished, decides nothing.
    expect(state(RUNNING, '{ kind = "update", status = "running" }')).toBe("running");
    expect(state(RUNNING, '{ kind = "create", status = "succeeded" }')).toBe("running");
  });

  it("a start, stop, update or upgrade in progress follows desired_state", () => {
    // The tenant is mid-change, so observed lags desired. Falling through to
    // "failed" would flash an error for every routine change; the operation
    // field already shows the progress.
    const UPDATING = '{ desired_state = "running", observed_state = "stopped" }';
    const STOPPING = '{ desired_state = "stopped", observed_state = "running" }';
    expect(state(UPDATING, '{ kind = "update", status = "running" }')).toBe("running");
    expect(state(STOPPING, '{ kind = "stop", status = "pending" }')).toBe("stopped");
    for (const kind of ["start", "stop", "update", "upgrade"]) {
      for (const status of ["pending", "running"]) {
        const op = `{ kind = "${kind}", status = "${status}" }`;
        expect([kind, status, state(UPDATING, op)]).toEqual([kind, status, "running"]);
        expect([kind, status, state(BROKEN, op)]).toEqual([kind, status, "running"]);
        expect([kind, status, state(STOPPING, op)]).toEqual([kind, status, "stopped"]);
      }
    }
    // Once the operation has finished, the tenant's own states decide again.
    expect(state(UPDATING, '{ kind = "update", status = "failed" }')).toBe("failed");
  });

  it("desired stopped is stopped", () => {
    expect(state(STOPPED, "nil")).toBe("stopped");
    expect(state('{ desired_state = "stopped", observed_state = "running" }', "nil")).toBe("stopped");
  });

  it("anything else is failed", () => {
    expect(state(BROKEN, "nil")).toBe("failed");
    expect(state('{ desired_state = "running", observed_state = "stopped" }', "nil")).toBe("failed");
    expect(state(BROKEN, '{ kind = "destroy", status = "failed" }')).toBe("failed");
  });
});

describe("instance shapes", () => {
  // Every field the provisioner's Tenant serialises, as GET /v1/tenants sends it.
  const TENANT = `{
    id = "7c6c1a1e-0000-4000-8000-000000000001", slug = "alice", owner_did = "did:plc:alice",
    plan_id = "small", host_id = "7c6c1a1e-0000-4000-8000-0000000000ff",
    happyview_version = "3.0.0-alpha.4", public_url = "https://alice.hpy.at",
    image = "ghcr.io/x/happyview:3.0.0-alpha.4", routed = true,
    desired_state = "running", observed_state = "running", spec_hash = "abc123",
    created_at = "2026-10-01T00:00:00Z", deleted_at = nil, purge_after = "2026-11-01T00:00:00Z",
    purged_at = nil, owner_confirmed_at = "2026-10-01T00:00:01Z",
  }`;
  const LIST_OP = '{ id = "op-1", kind = "create", status = "running", step = "apply" }';
  const FULL_OP = `{
    id = "op-2", tenant_id = "t", kind = "update", status = "failed",
    params = {}, steps = { { name = "plan" }, { name = "apply" } },
    error_code = "NoCapacity", error_message = "no host has room",
    requested_by = "did:plc:alice", created_at = "x",
  }`;

  it("public_instance is exactly the customer shape", () => {
    const { r1 } = run(`return public_instance(${TENANT}, ${LIST_OP})`);
    expect(r1).toEqual({
      id: "7c6c1a1e-0000-4000-8000-000000000001",
      slug: "alice",
      url: "https://alice.hpy.at",
      plan: "small",
      version: "3.0.0-alpha.4",
      state: "provisioning",
      createdAt: "2026-10-01T00:00:00Z",
      operation: { id: "op-1", kind: "create", status: "running", step: "apply" },
    });
  });

  it("public_instance never carries a provisioner-internal field", () => {
    for (const op of ["nil", LIST_OP, FULL_OP]) {
      const json = JSON.stringify(run(`return public_instance(${TENANT}, ${op})`).r1);
      for (const banned of [
        "host_id", "hostId", "image", "spec_hash", "specHash", "routed",
        "owner_confirmed_at", "ownerConfirmedAt", "purge_after", "purged_at",
        "deleted_at", "owner_did", "ownerDid", "requested_by", "params",
        "error_message", "ghcr.io", "abc123",
      ]) {
        expect(json).not.toContain(banned);
      }
    }
  });

  it("public_operation reads both provisioner operation shapes", () => {
    expect(run(`return public_operation(${FULL_OP})`).r1).toEqual({
      id: "op-2", kind: "update", status: "failed", step: "apply", error: "NoCapacity",
    });
    expect(run("return public_operation(nil)").r1).toBeNull();
  });

  it("admin_instance adds ownership, placement and the raw states", () => {
    const { r1 } = run(`return admin_instance(${TENANT}, nil, "host-a")`);
    expect(r1).toMatchObject({
      id: "7c6c1a1e-0000-4000-8000-000000000001",
      state: "running",
      ownerDid: "did:plc:alice",
      hostId: "7c6c1a1e-0000-4000-8000-0000000000ff",
      hostName: "host-a",
      desiredState: "running",
      observedState: "running",
      routed: true,
    });
    expect(JSON.stringify(r1)).not.toContain("abc123");
  });
});

describe("provisioner", () => {
  it("sends the token, the actor, the key and JSON to the configured URL", () => {
    const { r1, r2, calls } = run(`
      __decoded['{"tenant":1}'] = { tenant = { id = "t1" } }
      __reply = function() return { status = 201, body = '{"tenant":1}', headers = {} } end
      return provisioner(${CTX}, "POST", "/v1/tenants", { slug = "alice" }, "key-1")`);
    expect(r1).toBe(201);
    expect(r2).toEqual({ tenant: { id: "t1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("post");
    expect(calls[0].url).toBe("http://provisioner:8080/v1/tenants");
    expect(calls[0].opts.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "X-Actor-Did": "did:plc:alice",
      "Idempotency-Key": "key-1",
      "Content-Type": "application/json",
    });
    expect(calls[0].opts.body).toBe('{"slug":"alice"}');
  });

  it("a read sends no key, no body and no content type", () => {
    const { calls } = run(`return provisioner(${CTX}, "GET", "/v1/plans")`);
    expect(calls[0].fn).toBe("get");
    expect(calls[0].opts.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "X-Actor-Did": "did:plc:alice",
    });
    expect(calls[0].opts.body).toBeUndefined();
  });

  it("a missing URL or token is a transport failure, and nothing is sent", () => {
    for (const env of ['{ PROVISIONER_TOKEN = "tok" }', '{ PROVISIONER_URL = "http://p", PROVISIONER_TOKEN = "" }', "nil"]) {
      const { r1, r2, calls } = run(
        `return provisioner({ caller_did = "did:plc:alice", env = ${env} }, "GET", "/v1/plans")`,
      );
      expect(r1).toBeNull();
      expect(r2).toBe("provisioner not configured");
      expect(calls).toEqual([]);
    }
  });

  it("no reply at all is nil and a fixed message; the cause is only logged", () => {
    const { r1, r2, log } = run(`
      __reply = function() error("happyview-http.get: HTTP_ERROR: connect to 10.0.0.5 refused") end
      return provisioner(${CTX}, "GET", "/v1/plans")`);
    expect(r1).toBeNull();
    expect(r2).toBe("provisioner unreachable");
    expect(JSON.stringify(log)).toContain("10.0.0.5");
  });

  it("no caller is a transport failure, and nothing is sent", () => {
    for (const caller of ["nil", '""']) {
      const { r1, r2, calls } = run(
        `return provisioner({ caller_did = ${caller}, env = ${ENV} }, "GET", "/v1/plans")`,
      );
      expect(r1).toBeNull();
      expect(r2).toBe("no caller to act as");
      expect(calls).toEqual([]);
    }
  });

  it("the token never reaches the log", () => {
    const unreachable = run(`
      __reply = function() error("happyview-http.post: HTTP_ERROR: connection reset") end
      return provisioner(${CTX}, "POST", "/v1/tenants", { slug = "alice" }, "key-1")`);
    expect(unreachable.log).not.toEqual([]);
    expect(JSON.stringify(unreachable.log)).not.toContain(TOKEN);

    const refused = run(`
      __decoded["BOOM"] = { error = "Internal", message = "boom" }
      __reply = function() return { status = 500, body = "BOOM", headers = {} } end
      local status, body = provisioner(${CTX}, "POST", "/v1/tenants", { slug = "alice" }, "key-1")
      return provisioner_failure(status, body)`);
    expect(refused.r1.error).toBe("Upstream");
    expect(refused.log).not.toEqual([]);
    expect(JSON.stringify(refused.log)).not.toContain(TOKEN);
  });

  it("a body that is not JSON comes back as text", () => {
    const { r1, r2 } = run(`
      __reply = function() return { status = 502, body = "Bad Gateway", headers = {} } end
      return provisioner(${CTX}, "GET", "/v1/plans")`);
    expect(r1).toBe(502);
    expect(r2).toBe("Bad Gateway");
  });
});

describe("provisioner_failure", () => {
  it("a 5xx is Upstream, and the provisioner's text is logged, never returned", () => {
    const { r1, log } = run('return provisioner_failure(503, { error = "X", message = "SECRET" })');
    expect(r1.error).toBe("Upstream");
    expect(JSON.stringify(r1)).not.toContain("SECRET");
    expect(log.map((l) => l.level)).toEqual(["warn"]);
    expect(JSON.stringify(log)).toContain("SECRET");
  });

  it("a known code passes through with its message", () => {
    expect(run('return provisioner_failure(409, { error = "SlugTaken", message = "m" })').r1).toEqual({
      error: "SlugTaken",
      message: "m",
    });
  });

  it("every passthrough code passes, at the status the provisioner sends it", () => {
    const cases: [number, string][] = [
      [403, "Forbidden"], [404, "NotFound"], [400, "InvalidSlug"], [409, "SlugTaken"],
      [403, "NotEntitled"], [409, "InstanceLimit"], [503, "NoCapacity"], [409, "OperationInProgress"],
    ];
    for (const [status, code] of cases) {
      const { r1 } = run(`return provisioner_failure(${status}, { error = "${code}", message = "m" })`);
      expect(r1).toEqual({ error: code, message: "m" });
    }
  });

  it("a key still in flight is OperationInProgress, with a fixed message", () => {
    const { r1 } = run(
      'return provisioner_failure(409, { error = "IdempotencyKeyInFlight", message = "SECRET" })',
    );
    expect(r1.error).toBe("OperationInProgress");
    expect(r1.message).not.toContain("SECRET");
    expect(r1.message.length).toBeGreaterThan(0);
  });

  it("a refusal of the request itself is InvalidRequest, with the provisioner's fixed text", () => {
    for (const [status, code] of [
      [400, "UnknownPlan"], [400, "InvalidVersion"], [400, "NoChange"], [400, "EmptyUpdate"],
      [422, "IdempotencyKeyReused"],
    ] as const) {
      const { r1 } = run(`return provisioner_failure(${status}, { error = "${code}", message = "said ${code}" })`);
      expect(r1).toEqual({ error: "InvalidRequest", message: `said ${code}` });
    }
  });

  it("a deleted instance is NotFound, in the same words as a missing one", () => {
    const { r1 } = run('return provisioner_failure(409, { error = "TenantDeleted", message = "SECRET" })');
    expect(r1).toEqual({ error: "NotFound", message: "instance not found" });
  });

  it("an instance not yet live is OperationInProgress, with a fixed message", () => {
    const { r1 } = run('return provisioner_failure(409, { error = "NotLive", message = "SECRET" })');
    expect(r1).toEqual({
      error: "OperationInProgress",
      message: "This instance has not finished setting up yet.",
    });
  });

  it("anything else is Upstream", () => {
    for (const [status, body] of [
      ["401", '{ error = "Unauthorized", message = "SECRET" }'],
      ["400", '{ error = "Weird", message = "SECRET" }'],
      ["200", '{ error = "UnknownPlan", message = "SECRET" }'],
      ["500", '{ error = "Internal", message = "SECRET" }'],
      ["502", '"SECRET gateway"'],
      ["nil", '"provisioner unreachable"'],
      ["200", '{ error = "SlugTaken", message = "SECRET" }'],
    ]) {
      const { r1 } = run(`return provisioner_failure(${status}, ${body})`);
      expect(r1.error).toBe("Upstream");
      expect(JSON.stringify(r1)).not.toContain("SECRET");
    }
  });
});

describe("clickhouse", () => {
  it("sends credentials as headers and params as sorted, encoded arguments", () => {
    const { r1, calls } = run(`
      __decoded["ROWS"] = { data = { { n = 1 } } }
      __reply = function() return { status = 200, body = "ROWS", headers = {} } end
      return query(${CTX}, "SELECT {b:String}, {a:String}", { b = "x y", a = "1&2" })`);
    expect(r1).toEqual([{ n: 1 }]);
    expect(calls[0].url).toBe("http://clickhouse:8123?param_a=1%262&param_b=x%20y");
    expect(calls[0].opts.headers).toEqual({
      "x-clickhouse-user": "readonly",
      "x-clickhouse-key": "pw",
      "x-clickhouse-database": "telemetry",
    });
    expect(calls[0].url).not.toContain("pw");
  });

  it("names every missing variable, and sends nothing", () => {
    const { r1, r2, calls } = run(
      `return query({ env = { HAPPYPROTO_CLICKHOUSE_URL = "http://c" } }, "SELECT 1")`,
    );
    expect(r1).toBeNull();
    expect(r2).toBe(
      "missing script variable(s): HAPPYPROTO_CLICKHOUSE_USER, HAPPYPROTO_CLICKHOUSE_PASSWORD, HAPPYPROTO_CLICKHOUSE_DB",
    );
    expect(calls).toEqual([]);
  });

  it("no reply at all is nil and a message, not an error", () => {
    const { r1, r2 } = run(`
      __reply = function() error("HTTP_ERROR") end
      return query(${CTX}, "SELECT 1")`);
    expect(r1).toBeNull();
    expect(r2).toBe("telemetry store unreachable");
  });
});

describe("urlencode", () => {
  it("encodes a did:web with %, : and # into one opaque query value", () => {
    const { r1 } = run(`return url_encode("did:web:example.com%3A8080:u#frag")`);
    expect(r1).toBe("did%3Aweb%3Aexample.com%253A8080%3Au%23frag");
    // Decoding gives back exactly the DID, which is what the provisioner sees.
    expect(decodeURIComponent(r1)).toBe("did:web:example.com%3A8080:u#frag");
  });

  it("leaves RFC 3986 unreserved characters alone", () => {
    const { r1 } = run(`return url_encode("did:plc:abc-DEF_1.2~3")`);
    expect(r1).toBe("did%3Aplc%3Aabc-DEF_1.2~3");
  });

  it("encodes &, = and spaces, so a value cannot add a parameter", () => {
    const { r1 } = run(`return url_encode("a&owner_did=b c")`);
    expect(r1).toBe("a%26owner_did%3Db%20c");
  });
});

describe("validate", () => {
  // Copied from the provisioner's slug.rs tests.
  const VALID = ["abc", "alice", "a1b", "my-app", "a2345678901234567890123456789012"];
  const INVALID: [string, "invalid" | "reserved"][] = [
    ["ab", "invalid"],
    ["a23456789012345678901234567890123", "invalid"],
    ["Alice", "invalid"],
    ["ünïcode", "invalid"],
    ["a_b", "invalid"],
    ["1abc", "invalid"],
    ["-abc", "invalid"],
    ["abc-", "invalid"],
    ["a--b", "invalid"],
    ["admin", "reserved"],
    ["happyview", "reserved"],
    ["hpy", "reserved"],
    ["instance", "reserved"],
  ];
  const lit = (s: string) => JSON.stringify(s);

  it("is_slug accepts what slug.rs accepts", () => {
    for (const s of VALID) {
      expect([s, run(`return is_slug(${lit(s)})`).r1]).toEqual([s, true]);
    }
  });

  it("is_slug rejects what slug.rs rejects, with the provisioner's reason", () => {
    for (const [s, reason] of INVALID) {
      const { r1, r2 } = run(`return is_slug(${lit(s)})`);
      expect([s, r1, r2]).toEqual([s, false, reason]);
    }
    expect(run("return is_slug(nil)").r1).toBe(false);
    expect(run("return is_slug(123)").r1).toBe(false);
  });

  it("is_slug cannot see the provisioner's configured reservations", () => {
    // slug.rs's test also rejects "trezy", from the extra_reserved set its
    // test passes in. That set is provisioner configuration a script cannot
    // read, so the provisioner stays the authority and answers InvalidSlug.
    expect(run('return is_slug("trezy")').r1).toBe(true);
  });

  it("is_uuid", () => {
    expect(run('return is_uuid("7c6c1a1e-0000-4000-8000-000000000001")').r1).toBe(true);
    expect(run('return is_uuid("7C6C1A1E-0000-4000-8000-00000000000A")').r1).toBe(true);
    for (const bad of ["", "7c6c1a1e00004000800000000000001", "7c6c1a1e-0000-4000-8000-00000000000", "x7c6c1a1e-0000-4000-8000-000000000001", "7c6c1a1e-0000-4000-8000-00000000000g"]) {
      expect([bad, run(`return is_uuid(${lit(bad)})`).r1]).toEqual([bad, false]);
    }
    expect(run("return is_uuid(nil)").r1).toBe(false);
  });

  it("is_did", () => {
    for (const good of ["did:plc:4jrld6fwpnwqehtce56qshzv", "did:web:example.com", "did:web:localhost%3A3000"]) {
      expect([good, run(`return is_did(${lit(good)})`).r1]).toEqual([good, true]);
    }
    for (const bad of ["", "plc:abc", "did:PLC:abc", "did:plc:", "did:plc:abc:", "did:plc:abc%", "did:plc:a b", `did:plc:${"a".repeat(2048)}`]) {
      expect([bad.slice(0, 20), run(`return is_did(${lit(bad)})`).r1]).toEqual([bad.slice(0, 20), false]);
    }
  });
});

describe("owned_tenant", () => {
  const ID = "7c6c1a1e-0000-4000-8000-000000000001";
  const reply = (owner: string, deleted = "nil") => `
    __decoded["T"] = { tenant = { id = "${ID}", owner_did = "${owner}", deleted_at = ${deleted} }, current_operation = { id = "op" } }
    __reply = function() return { status = 200, body = "T", headers = {} } end`;

  it("the caller's own live tenant comes back with its operation", () => {
    const { r1, r2, calls } = run(`${reply("did:plc:alice")}
      return owned_tenant(${CTX}, "${ID}")`);
    expect(r1.tenant.id).toBe(ID);
    expect(r1.current_operation).toEqual({ id: "op" });
    expect(r2).toBeNull();
    expect(calls.map((c) => `${c.fn} ${c.url}`)).toEqual([`get http://provisioner:8080/v1/tenants/${ID}`]);
  });

  it("another owner's tenant is NotFound, though the provisioner returned it", () => {
    const { r1, r2 } = run(`${reply("did:plc:mallory")}
      return owned_tenant(${CTX}, "${ID}")`);
    expect(r1).toBeNull();
    expect(r2).toEqual({ error: "NotFound", message: "instance not found" });
  });

  it("a deleted tenant is NotFound, in the same words", () => {
    const { r1, r2 } = run(`${reply("did:plc:alice", '"2026-10-02T09:00:00Z"')}
      return owned_tenant(${CTX}, "${ID}")`);
    expect(r1).toBeNull();
    expect(r2).toEqual({ error: "NotFound", message: "instance not found" });
  });

  it("with include_deleted, the caller's own deleted tenant comes back", () => {
    const { r1, r2 } = run(`${reply("did:plc:alice", '"2026-10-02T09:00:00Z"')}
      return owned_tenant(${CTX}, "${ID}", true)`);
    expect(r1.tenant.id).toBe(ID);
    expect(r2).toBeNull();
  });

  it("with include_deleted, another owner's tenant is still NotFound", () => {
    for (const deleted of ["nil", '"2026-10-02T09:00:00Z"']) {
      const { r1, r2 } = run(`${reply("did:plc:mallory", deleted)}
        return owned_tenant(${CTX}, "${ID}", true)`);
      expect(r1).toBeNull();
      expect(r2).toEqual({ error: "NotFound", message: "instance not found" });
    }
  });

  it("MEMBER_ACCESS admits exactly the gate's levels", () => {
    const { r1 } = run(`local out = {}
      for k in pairs(MEMBER_ACCESS) do out[#out + 1] = k end
      table.sort(out)
      return out`);
    expect(r1).toEqual(["read", "read_self", "write"]);
  });

  it("a provisioner failure is mapped as any other", () => {
    const { r1, r2 } = run(`
      __decoded["E"] = { error = "Internal", message = "SECRET" }
      __reply = function() return { status = 500, body = "E", headers = {} } end
      return owned_tenant(${CTX}, "${ID}")`);
    expect(r1).toBeNull();
    expect(r2.error).toBe("Upstream");
    expect(JSON.stringify(r2)).not.toContain("SECRET");
  });
});

describe("follow_operation", () => {
  it("starts an instance.operation job for the operation, as the caller", () => {
    const { r1, r2, calls } = run('return follow_operation({ id = "op-1", kind = "create" })');
    expect(r1).toBe("job-0001");
    expect(r2).toBeNull();
    // No opts: the job polls the provisioner, so it needs no PDS session.
    expect(calls).toEqual([{ fn: "create", job_type: "instance.operation", input: { operationId: "op-1" } }]);
  });

  it("a create that raises is Upstream, logged, and never echoed", () => {
    const { r1, r2, log } = run(`
      __job = function() error("happyview-jobs.create: HOST_ERROR SENTINEL-db") end
      return follow_operation({ id = "op-1" })`);
    expect(r1).toBeNull();
    expect(r2.error).toBe("Upstream");
    expect(r2.message).not.toContain("SENTINEL");
    expect(log.map((l) => l.level)).toEqual(["warn"]);
  });

  it("a create that answers no id is Upstream", () => {
    const { r1, r2 } = run(`
      __job = function() return nil end
      return follow_operation({ id = "op-1" })`);
    expect(r1).toBeNull();
    expect(r2.error).toBe("Upstream");
  });

  it("no operation to follow is Upstream, and no job is made", () => {
    for (const op of ["nil", "{}", "{ id = 7 }"]) {
      const { r1, r2, calls } = run(`return follow_operation(${op})`);
      expect(r1).toBeNull();
      expect(r2.error).toBe("Upstream");
      expect(calls).toEqual([]);
    }
  });
});
