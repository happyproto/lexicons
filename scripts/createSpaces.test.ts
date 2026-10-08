/**
 * admin.createSpaces, executed. The script is generated from source exactly
 * as `bun run gen` does and run under Lua 5.4 behind a stateful spaces stub,
 * so the paths a real HappyView cannot be steered into -- a space anchored on
 * the wrong DID, a create or an add that loses a race, a failure part-way
 * through the staff list -- are proven here. The integration suite covers the
 * same script against the real thing.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const SOURCE = "src/at/happyproto/admin/createSpaces.lua";

async function generated(): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(SOURCE, "utf8");
  const blocks = expand(parseDirective(text, SOURCE), [...prelude.keys()]);
  return render(SOURCE, blocks.map((name) => prelude.get(name)!), text);
}
const SCRIPT = await generated();

/**
 * A spaces library with state: which spaces exist and who belongs to each.
 * `create` anchors the space on `__authority`, which a test points somewhere
 * other than HAPPYPROTO_DID to play an instance with a service identity.
 * Errors are raised in the Lua bridge's own shape (plugins repo,
 * plugins/happyview/lua/src/require.rs `plugin_error`).
 */
const SPACES = String.raw`
__existing = {}
__members = {}
__authority = "did:plc:hp"

function __raise(label, code)
  error(label .. ": Plugin returned error: " .. code .. " - stubbed " .. code)
end

__create = function(opts)
  local uri = "at://" .. __authority .. "/space/" .. opts.spaceType .. "/" .. opts.skey
  if __existing[uri] then __raise("happyview.spaces.create", "CONFLICT") end
  __existing[uri] = true
  __members[uri] = { [__authority] = "write" }
  return { uri = uri, spaceType = opts.spaceType }
end

__add = function(uri, spec)
  __members[uri] = __members[uri] or {}
  if __members[uri][spec.did] then __raise("happyview.spaces.get:add_member", "CONFLICT") end
  __members[uri][spec.did] = spec.access
  return { did = spec.did, access = spec.access }
end

package.preload["happyview.spaces"] = function()
  return {
    info = function(uri)
      __calls[#__calls + 1] = { fn = "info", uri = uri }
      return __existing[uri] and { uri = uri } or nil
    end,
    create = function(opts)
      __calls[#__calls + 1] = { fn = "create", input = opts }
      return __create(opts)
    end,
    get = function(uri)
      return {
        is_member = function(_, did)
          __calls[#__calls + 1] = { fn = "is_member", uri = uri, did = did }
          return (__members[uri] or {})[did] ~= nil
        end,
        add_member = function(_, spec)
          __calls[#__calls + 1] = { fn = "add_member", uri = uri, did = spec.did, input = spec }
          return __add(uri, spec)
        end,
        delete = function()
          __calls[#__calls + 1] = { fn = "delete", uri = uri }
          __existing[uri] = nil
          return true
        end,
      }
    end,
  }
end
`;

const HP = "did:plc:hp";
const ADMIN = `at://${HP}/space/at.happyproto.admin/main`;
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const OWNER = `{ caller_did = "${HP}", env = { HAPPYPROTO_DID = "${HP}" } }`;
const MEMBER_LIST = { $type: "com.atproto.simplespace.defs#memberListPolicy" };

type Call = { fn: string; uri?: string; did?: string; input?: any };
type Run = { out: any; calls: Call[]; log: any[] };

/** An empty Lua table encodes as {}; a list field means []. */
const list = (x: unknown) => (Array.isArray(x) ? x : x && typeof x === "object" && Object.keys(x).length === 0 ? [] : x);

/**
 * handle(input, ctx) after `setup`, which runs once the script has loaded
 * and may steer the stub's `__` globals. Twice when `twice`, against the same
 * state, reporting the second.
 */
function run(input: string, { ctx = OWNER, setup = "", twice = false } = {}): Run {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so createSpaces was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    SPACES,
    SCRIPT,
    setup,
    twice ? `handle(${input}, ${ctx}); __calls = {}` : "",
    `local __out = handle(${input}, ${ctx})`,
    "io.write(__encode({ out = __out, calls = __calls, log = __log }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return { out: parsed.out, calls: list(parsed.calls) as Call[], log: list(parsed.log) as any[] };
}

const fns = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn);

describe("the owner gate", () => {
  it("refuses anyone but HAPPYPROTO_DID before any spaces call", () => {
    for (const caller of ['"did:plc:alice"', '""', "nil"]) {
      const { out, calls } = run(`{ staff = { "did:plc:s1" } }`, {
        ctx: `{ caller_did = ${caller}, env = { HAPPYPROTO_DID = "${HP}" } }`,
      });
      expect([caller, out.error]).toEqual([caller, "Forbidden"]);
      expect(calls).toEqual([]);
    }
  });

  it("refuses everyone when HAPPYPROTO_DID is unset or malformed", () => {
    for (const env of ["{}", '{ HAPPYPROTO_DID = "hp" }']) {
      const { out, calls } = run("{}", { ctx: `{ caller_did = "${HP}", env = ${env} }` });
      expect([env, out.error]).toEqual([env, "Forbidden"]);
      expect(calls).toEqual([]);
    }
  });
});

describe("staff validation, in the script itself", () => {
  it("refuses anything but a list of at most 50 DIDs, before any spaces call", () => {
    const fifty_one = `{ ${Array.from({ length: 51 }, (_, i) => `"did:plc:s${i}"`).join(", ")} }`;
    for (const staff of [
      '{ "alice" }',
      '{ "did:plc:s1", "" }',
      "{ 7 }",
      fifty_one,
      '"did:plc:s1"',
      '{ a = "did:plc:s1" }',
      '{ "did:plc:s1", x = "did:plc:s2" }',
    ]) {
      const { out, calls } = run(`{ staff = ${staff} }`);
      expect([staff.slice(0, 30), out.error]).toEqual([staff.slice(0, 30), "InvalidRequest"]);
      expect(calls).toEqual([]);
    }
  });

  it("takes exactly 50", () => {
    const fifty = `{ ${Array.from({ length: 50 }, (_, i) => `"did:plc:s${i}"`).join(", ")} }`;
    const { out } = run(`{ staff = ${fifty} }`);
    expect(list(out.staffAdded)).toHaveLength(50);
  });

  it("adds a DID listed twice once", () => {
    const { out, calls } = run('{ staff = { "did:plc:s1", "did:plc:s1" } }');
    expect(list(out.staffAdded)).toEqual(["did:plc:s1"]);
    expect(fns(calls, "add_member")).toHaveLength(1);
  });
});

describe("creating the spaces", () => {
  it("creates both, member-only, and adds staff with write access", () => {
    const { out, calls } = run('{ staff = { "did:plc:s1" } }');
    expect({ ...out, staffAdded: list(out.staffAdded) }).toEqual({
      adminSpace: { uri: ADMIN, created: true },
      customersSpace: { uri: CUSTOMERS, created: true },
      staffAdded: ["did:plc:s1"],
    });
    const created = fns(calls, "create").map((c) => c.input);
    expect(created.map((c) => [c.spaceType, c.skey])).toEqual([
      ["at.happyproto.admin", "main"],
      ["at.happyproto.customers", "main"],
    ]);
    for (const c of created) {
      expect(c.read_policy).toEqual(MEMBER_LIST);
      expect(c.write_policy).toEqual(MEMBER_LIST);
    }
    expect(fns(calls, "add_member")).toEqual([
      { fn: "add_member", uri: ADMIN, did: "did:plc:s1", input: { did: "did:plc:s1", access: "write" } },
    ]);
  });

  it("a second call creates nothing and adds no one", () => {
    const { out, calls } = run('{ staff = { "did:plc:s1", "did:plc:hp" } }', { twice: true });
    expect([out.adminSpace.created, out.customersSpace.created]).toEqual([false, false]);
    expect(list(out.staffAdded)).toEqual([]);
    expect(fns(calls, "create")).toEqual([]);
    expect(fns(calls, "add_member")).toEqual([]);
  });

  it("a create that loses a race (CONFLICT) re-checks with info and keeps the space", () => {
    const { out, calls } = run("{}", {
      setup: `
        local real = __create
        __create = function(opts)
          real(opts)  -- someone else's call lands first
          __raise("happyview.spaces.create", "CONFLICT")
        end`,
    });
    expect(out.adminSpace).toEqual({ uri: ADMIN, created: false });
    expect(out.customersSpace).toEqual({ uri: CUSTOMERS, created: false });
    expect(fns(calls, "info").map((c) => c.uri)).toEqual([ADMIN, ADMIN, CUSTOMERS, CUSTOMERS]);
  });

  it("a create that fails otherwise is Upstream, and the cause stays in the log", () => {
    const { out, log } = run("{}", {
      setup: `__create = function() __raise("happyview.spaces.create", "HOST_ERROR") end`,
    });
    expect(out.error).toBe("Upstream");
    expect(JSON.stringify(out)).not.toContain("HOST_ERROR");
    expect(JSON.stringify(log)).toContain("HOST_ERROR");
  });

  it("a space anchored on another DID is deleted -- only that one -- and is Upstream", () => {
    const stray = "at://did:web:api.example.com/space/at.happyproto.admin/main";
    const { out, calls } = run('{ staff = { "did:plc:s1" } }', {
      setup: `__authority = "did:web:api.example.com"`,
    });
    expect(out.error).toBe("Upstream");
    expect(out.message).toContain("HAPPYPROTO_DID");
    expect(fns(calls, "delete")).toEqual([{ fn: "delete", uri: stray }]);
    // The derived uri is never deleted, nothing else is created, no one added.
    expect(calls.some((c) => c.fn === "delete" && c.uri === ADMIN)).toBe(false);
    expect(fns(calls, "create")).toHaveLength(1);
    expect(fns(calls, "add_member")).toEqual([]);
  });
});

describe("adding staff", () => {
  it("an add that loses a race (CONFLICT) is skipped, not a failure", () => {
    const { out } = run('{ staff = { "did:plc:s1", "did:plc:s2" } }', {
      setup: `
        local real = __add
        __add = function(uri, spec)
          if spec.did == "did:plc:s1" then
            __raise("happyview.spaces.get:add_member", "CONFLICT")
          end
          return real(uri, spec)
        end`,
    });
    expect(out.error).toBeUndefined();
    expect(list(out.staffAdded)).toEqual(["did:plc:s2"]);
  });

  it("a message that merely mentions CONFLICT is not one", () => {
    const { out } = run('{ staff = { "did:plc:s1" } }', {
      setup: `__add = function() error("happyview.spaces.get:add_member: CONFLICT in the database") end`,
    });
    expect(out.error).toBe("Upstream");
  });

  it("a failure part-way is Upstream, naming who was already added", () => {
    const { out } = run('{ staff = { "did:plc:s1", "did:plc:s2", "did:plc:s3" } }', {
      setup: `
        local real = __add
        __add = function(uri, spec)
          if spec.did == "did:plc:s3" then
            __raise("happyview.spaces.get:add_member", "HOST_ERROR")
          end
          return real(uri, spec)
        end`,
    });
    expect(out.error).toBe("Upstream");
    expect(out.message).toContain("Already added: did:plc:s1, did:plc:s2.");
    expect(out.message).not.toContain("did:plc:s3");
    expect(out.message).not.toContain("HOST_ERROR");
  });

  it("a failure on the first says no one was added", () => {
    const { out } = run('{ staff = { "did:plc:s1" } }', {
      setup: `__add = function() __raise("happyview.spaces.get:add_member", "NOT_AUTHORIZED") end`,
    });
    expect(out.error).toBe("Upstream");
    expect(out.message).toContain("No staff were added.");
  });

  it("an existing member, even read-only, is skipped and left as it was", () => {
    const { out, calls } = run('{ staff = { "did:plc:s1" } }', {
      setup: `__existing["${ADMIN}"] = true
        __existing["${CUSTOMERS}"] = true
        __members["${ADMIN}"] = { ["did:plc:s1"] = "read" }`,
    });
    expect(list(out.staffAdded)).toEqual([]);
    expect(fns(calls, "add_member")).toEqual([]);
  });
});
