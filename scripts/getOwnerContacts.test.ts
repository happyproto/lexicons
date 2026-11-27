/**
 * internal.getOwnerContacts (HAP-463 phase 2), executed: generated from source
 * exactly as `bun run gen` does and run under Lua behind a stubbed spaces
 * library. What it must never do: answer anyone but the provisioner, answer a
 * record someone other than the space's creator wrote, answer a pending
 * address, or log an address.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const PATH = "src/at/happyproto/internal/getOwnerContacts.lua";
const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
const text = await readFile(PATH, "utf8");
const SCRIPT = render(PATH, expand(parseDirective(text, PATH), [...prelude.keys()]).map((b) => prelude.get(b)!), text);

const PROV = "did:web:notices.happyproto.at";
const A = "at://did:plc:spacea/space/at.happyproto.preferences/self";
const B = "at://did:plc:spaceb/space/at.happyproto.preferences/self";

/**
 * `__spaces[uri]` = { creator, type?, skey?, records = { [collection] = { author, record } } },
 * `__raise[uri]` = true makes every read of that space raise.
 */
const STUBS = String.raw`
__spaces = {}
__raise = {}
package.preload["happyview.spaces"] = function()
  return {
    info = function(uri)
      __calls[#__calls + 1] = { fn = "info", uri = uri }
      if __raise[uri] then error("stubbed outage") end
      local s = __spaces[uri]
      if not s then return nil end
      -- As happyview.spaces answers: the type is spaceType.
      if s.old_shape then
        return { uri = uri, creator_did = s.creator, type_nsid = s.type or "at.happyproto.preferences", skey = s.skey or "self" }
      end
      return { uri = uri, creator_did = s.creator, spaceType = s.type or "at.happyproto.preferences", skey = s.skey or "self" }
    end,
    get = function(uri)
      return {
        access = function() return nil end,
        records = function(_, q)
          __calls[#__calls + 1] = { fn = "records", uri = uri, collection = q.collection }
          if __raise[uri] then error("stubbed outage") end
          local s = __spaces[uri] or { records = {} }
          local r = (s.records or {})[q.collection]
          if not r then return { records = {} } end
          return { records = { { rkey = r.rkey or "self", author_did = r.author, record = r.record } } }
        end,
      }
    end,
  }
end
`;

const CTX = (caller = PROV, env = `PROVISIONER_DID = "${PROV}"`) =>
  `{ caller_did = ${caller === "nil" ? "nil" : `"${caller}"`}, env = { HAPPYPROTO_DID = "did:plc:hp", ${env} } }`;

function run(input: string, { setup = "", ctx = CTX() } = {}): { out: any; calls: any[]; log: any[] } {
  if (!lua) {
    throw new Error("no lua on PATH, so getOwnerContacts was never executed. Install Lua, or set ALLOW_SKIP_LUA=1.");
  }
  const source = [
    HARNESS,
    STUBS,
    SCRIPT,
    setup,
    `local __out = handle(${input}, ${ctx})`,
    "io.write(__encode({ out = __out, calls = __calls, log = __log }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua!, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  return { out: parsed.out, calls: list(parsed.calls), log: list(parsed.log) };
}

const space = (uri: string, creator: string, records: string) =>
  `__spaces["${uri}"] = { creator = "${creator}", records = ${records} }`;
const contact = (author: string, record: string) =>
  `["at.happyproto.preferences.contact"] = { author = "${author}", record = ${record} }`;
const notices = (author: string, record: string) =>
  `["at.happyproto.preferences.notices"] = { author = "${author}", record = ${record} }`;

describe("internal.getOwnerContacts", () => {
  it("answers the creator's address and setting for each space, in order", () => {
    const setup = [
      space(A, "did:plc:alice", `{ ${contact("did:plc:alice", `{ email = "alice@example.com", source = "owner" }`)} }`),
      space(B, "did:plc:bob", `{ ${contact("did:plc:bob", `{ email = "bob@example.com" }`)}, ${notices("did:plc:bob", "{ maintenance = false }")} }`),
    ].join("\n");
    const { out, log } = run(`{ spaces = { "${A}", "${B}", "${A}" } }`, { setup });
    expect(out).toEqual({
      contacts: [
        { space: A, status: "ok", creator: "did:plc:alice", email: "alice@example.com", maintenance: true },
        { space: B, status: "ok", creator: "did:plc:bob", email: "bob@example.com", maintenance: false },
      ],
    });
    expect(log).toEqual([]);
  });

  it("reads the space type under either name happyview.spaces has used", () => {
    const setup = [
      space(A, "did:plc:alice", `{ ${contact("did:plc:alice", `{ email = "alice@example.com" }`)} }`),
      `__spaces["${A}"].old_shape = true`,
    ].join("\n");
    expect(run(`{ spaces = { "${A}" } }`, { setup }).out.contacts[0].status).toBe("ok");
  });

  it("takes a single space as a plain string, as HappyView passes one query value", () => {
    const setup = space(A, "did:plc:alice", `{ ${contact("did:plc:alice", `{ email = "alice@example.com" }`)} }`);
    expect(run(`{ spaces = "${A}" }`, { setup }).out.contacts[0].email).toBe("alice@example.com");
  });

  it("ignores a record someone other than the creator wrote", () => {
    const setup = space(
      A,
      "did:plc:alice",
      `{ ${contact("did:plc:mallory", `{ email = "mallory@example.com" }`)}, ${notices("did:plc:mallory", "{ maintenance = false }")} }`,
    );
    expect(run(`{ spaces = { "${A}" } }`, { setup }).out.contacts).toEqual([
      { space: A, status: "ok", creator: "did:plc:alice", maintenance: true },
    ]);
  });

  it("never answers a pending address, or something that is not one", () => {
    for (const record of [`{ pendingEmail = "new@example.com" }`, `{ email = "not an email" }`, `{ source = "owner" }`]) {
      const setup = space(A, "did:plc:alice", `{ ${contact("did:plc:alice", record)} }`);
      const c = run(`{ spaces = { "${A}" } }`, { setup }).out.contacts[0];
      expect([record, c.status, c.email]).toEqual([record, "ok", undefined]);
    }
  });

  it("says missing for a space that isn't there, or isn't a preferences space", () => {
    const setup = `__spaces["${B}"] = { creator = "did:plc:bob", type = "at.happyproto.admin", records = {} }`;
    expect(run(`{ spaces = { "${A}", "${B}" } }`, { setup }).out.contacts.map((c: any) => c.status)).toEqual([
      "missing",
      "missing",
    ]);
  });

  it("says unreadable when a space can't be read, logs only counts, and still answers the rest", () => {
    const setup = [
      `__raise["${A}"] = true`,
      space(B, "did:plc:bob", `{ ${contact("did:plc:bob", `{ email = "bob@example.com" }`)} }`),
    ].join("\n");
    const { out, log } = run(`{ spaces = { "${A}", "${B}" } }`, { setup });
    expect(out.contacts.map((c: any) => c.status)).toEqual(["unreadable", "ok"]);
    expect(JSON.stringify(log)).not.toContain("@");
    expect(log.map((l: any) => l.fields)).toEqual([{ asked: 2, unreadable: 1 }]);
  });

  it("refuses everyone but the provisioner, before reading anything", () => {
    for (const ctx of [
      CTX("did:plc:alice"),
      CTX("did:plc:hp"),
      CTX("nil"),
      CTX(PROV, ""),
      CTX(PROV, `PROVISIONER_DID = "did:plc:hp"`),
    ]) {
      const { out, calls } = run(`{ spaces = { "${A}" } }`, { ctx });
      expect([ctx, out.error]).toEqual([ctx, "Forbidden"]);
      expect(calls).toEqual([]);
    }
  });

  it("refuses malformed input before reading anything", () => {
    const many = Array.from({ length: 51 }, (_, i) => `"at://did:plc:s${i}/space/at.happyproto.preferences/self"`).join(", ");
    for (const input of [
      "{}",
      "{ spaces = {} }",
      `{ spaces = { ${many} } }`,
      `{ spaces = { "at://did:plc:x/space/at.happyproto.admin/main" } }`,
      `{ spaces = { "at://did:plc:x/space/at.happyproto.preferences/other" } }`,
      `{ spaces = { 5 } }`,
    ]) {
      const { out, calls } = run(input);
      expect([input.slice(0, 60), out.error]).toEqual([input.slice(0, 60), "InvalidRequest"]);
      expect(calls).toEqual([]);
    }
  });
});
