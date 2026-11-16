/**
 * The preferences space (HAP-463), executed: actor.syncAccount's part of it
 * and the contact scripts, each generated from source exactly as `bun run
 * gen` does and run under Lua 5.4 behind a stateful spaces library and a
 * stateful fake provisioner. The integration suite runs the same scripts on a
 * real HappyView, where a sign-in has no PDS session behind it and so never
 * reads an address; seeding from the PDS is proven here.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

async function generated(name: string): Promise<string> {
  const path = `src/at/happyproto/actor/${name}.lua`;
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(path, "utf8");
  const blocks = expand(parseDirective(text, path), [...prelude.keys()]);
  return render(path, blocks.map((block) => prelude.get(block)!), text);
}

const SCRIPTS = Object.fromEntries(
  await Promise.all(
    ["syncAccount", "getContact", "setContactEmail", "confirmContactEmail", "removeContactEmail", "setNotices"].map(
      async (name) => [name, await generated(name)] as const,
    ),
  ),
);

const SPACE = "at://did:plc:prefs/space/at.happyproto.preferences/self";
const APP = "did:plc:hp#happyproto_app";

/**
 * Stubs with state, steered through `__` globals:
 * - spaces: `__space_exists` (a space HappyView has but the provisioner has
 *   not recorded), `__records` by collection, `__customer` for the gate.
 * - provisioner: `__account`, `__proofs` (lowercase address -> true),
 *   `__links` (addresses sent a link), `__fail[path]` (a status and error).
 * - happyview.account: `__pds`.
 * Replies are registered in the harness's `__decoded` so json.decode finds
 * them.
 */
const STUBS = String.raw`
__space_exists = false
__email_on = true
__put_space_failures = 0
__records = {}
__customer = true
__account = {}
__proofs = {}
__links = {}
__fail = {}
__pds = nil
__reply_n = 0

local function respond(status, body)
  __reply_n = __reply_n + 1
  local key = "reply-" .. __reply_n
  __decoded[key] = body
  return { status = status, body = key, headers = {} }
end

local function emails_in(body)
  local out = {}
  local list = body:match('"emails":%[(.-)%]') or ""
  for e in list:gmatch('"([^"]*)"') do out[#out + 1] = e end
  return out
end

__reply = function(method, url, opts)
  local path = url:gsub("^http://provisioner", "")
  local failing = __fail[method .. " " .. path]
  if failing then return respond(failing[1], { error = failing[2], message = "stubbed " .. failing[2] }) end
  if method == "get" and path == "/v1/account" then
    return respond(200, { preferences_space = __account.preferences_space, contact_email = __email_on })
  elseif method == "put" and path == "/v1/account/preferences-space" then
    if __put_space_failures > 0 then
      __put_space_failures = __put_space_failures - 1
      return respond(503, { error = "Unavailable", message = "stubbed" })
    end
    __account.preferences_space = opts.body:match('"uri":"([^"]+)"')
    return respond(200, { preferences_space = __account.preferences_space })
  elseif method == "put" and path == "/v1/account/email" then
    return respond(200, { email_recorded = true })
  elseif method == "post" and path == "/v1/account/email-proofs/check" then
    local results = {}
    for i, e in ipairs(emails_in(opts.body)) do
      results[i] = { verified = __proofs[e:lower()] == true }
    end
    return respond(200, { results = results })
  elseif method == "post" and path == "/v1/account/contact-email/verification" then
    __links[#__links + 1] = opts.body:match('"email":"([^"]+)"')
    return respond(200, { expires_at = "2026-11-17T00:00:00.000Z" })
  elseif method == "post" and path == "/v1/account/contact-email/confirm" then
    __proofs[__links[#__links]:lower()] = true
    return respond(200, { confirmed = true })
  elseif method == "delete" and path == "/v1/account/email-proofs" then
    __proofs = {}
    return respond(200, { removed = true })
  end
  return respond(404, { error = "NotFound", message = "no stub for " .. method .. " " .. path })
end

package.preload["happyview.account"] = function()
  return { email = function() return __pds end }
end

package.preload["happyview.spaces"] = function()
  return {
    create = function(opts)
      __calls[#__calls + 1] = { fn = "create", input = opts }
      if __space_exists then
        error("happyview.spaces.create: Plugin returned error: CONFLICT - stubbed CONFLICT")
      end
      __space_exists = true
      return { uri = "${SPACE}" }
    end,
    get = function(uri)
      return {
        access = function(_, did)
          if uri:find("customers", 1, true) and __customer then return "read" end
          return nil
        end,
        records = function(_, q)
          __calls[#__calls + 1] = { fn = "records", uri = uri, collection = q.collection }
          local r = __records[q.collection]
          if r == nil then return { records = {} } end
          return { records = { { rkey = "self", author_did = "did:plc:alice", record = r } } }
        end,
        put_record = function(_, spec)
          __calls[#__calls + 1] = { fn = "put_record", uri = uri, collection = spec.collection, record = spec.record }
          __records[spec.collection] = spec.record
          return { uri = uri, cid = "cid" }
        end,
      }
    end,
  }
end
`;

const CTX = (env = `HAPPYPROTO_APP = "${APP}"`) =>
  `{ caller_did = "did:plc:alice", env = { HAPPYPROTO_DID = "did:plc:hp", PROVISIONER_URL = "http://provisioner", PROVISIONER_TOKEN = "t", ${env} } }`;
const KEY = "11111111-2222-3333-4444-555555555555";

type Run = { out: any; calls: any[]; log: any[]; records: any; account: any; links: string[] };
const list = (x: unknown) => (Array.isArray(x) ? x : x && typeof x === "object" && Object.keys(x).length === 0 ? [] : x);

function run(script: string, input: string, { setup = "", ctx = CTX() } = {}): Run {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so the preferences scripts were never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    STUBS,
    SCRIPTS[script],
    setup,
    `local __out = handle(${input}, ${ctx})`,
    "io.write(__encode({ out = __out, calls = __calls, log = __log, records = __records, account = __account, links = __links }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua!, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return {
    out: parsed.out,
    calls: list(parsed.calls) as any[],
    log: list(parsed.log) as any[],
    records: list(parsed.records),
    account: list(parsed.account),
    links: list(parsed.links) as string[],
  };
}

const SYNC = `{ idempotencyKey = "${KEY}" }`;
const recorded = `__account.preferences_space = "${SPACE}"`;
const contact = (lua: string) => `__records["at.happyproto.preferences.contact"] = ${lua}`;
const proven = (email: string) => `__proofs["${email}"] = true`;

describe("sign-in (syncAccount)", () => {
  it("creates the space as the caller, managed by HappyProto, and records it", () => {
    const { out, calls, account } = run("syncAccount", SYNC);
    expect(out).toEqual({ recorded: true, emailRecorded: true });
    const [create, ...more] = calls.filter((c) => c.fn === "create");
    expect(more).toEqual([]);
    expect(create.input.spaceType).toBe("at.happyproto.preferences");
    expect(create.input.skey).toBe("self");
    const managed = { $type: "com.atproto.simplespace.defs#managingAppPolicy", managingApp: APP };
    expect(create.input.read_policy).toEqual(managed);
    expect(create.input.write_policy).toEqual(managed);
    expect(account.preferences_space).toBe(SPACE);
  });

  it("seeds the contact record from the PDS address the first time", () => {
    const { records } = run("syncAccount", SYNC, { setup: `__pds = { email = "alice@example.com", email_confirmed = true }` });
    const record = records["at.happyproto.preferences.contact"];
    expect(record.email).toBe("alice@example.com");
    expect(record.source).toBe("pds");
    expect(record.$type).toBe("at.happyproto.preferences.contact");
  });

  it("never seeds again, even after the owner removed their address", () => {
    for (const existing of [`{ email = "mine@example.com", source = "owner" }`, `{ source = "owner" }`]) {
      const { calls } = run("syncAccount", SYNC, {
        setup: [recorded, contact(existing), `__pds = { email = "pds@example.com" }`].join("\n"),
      });
      expect(calls.filter((c) => c.fn === "put_record")).toEqual([]);
      expect(calls.filter((c) => c.fn === "create")).toEqual([]);
    }
  });

  it("promotes a change whose link was opened", () => {
    const { records } = run("syncAccount", SYNC, {
      setup: [recorded, contact(`{ email = "old@example.com", pendingEmail = "new@example.com", source = "owner" }`), proven("new@example.com")].join("\n"),
    });
    const record = records["at.happyproto.preferences.contact"];
    expect([record.email, record.pendingEmail]).toEqual(["new@example.com", undefined]);
  });

  it("without HAPPYPROTO_APP creates nothing, and the sign-in still succeeds", () => {
    for (const env of ["", `HAPPYPROTO_APP = "not a did"`]) {
      const { out, calls } = run("syncAccount", SYNC, { ctx: CTX(env) });
      expect(out.recorded).toBe(true);
      expect(calls.filter((c) => c.fn === "create")).toEqual([]);
    }
  });

  it("creates nothing while contact email is off, and the settings say so", () => {
    const off = "__email_on = false";
    const { out, calls } = run("syncAccount", SYNC, { setup: [off, `__pds = { email = "a@example.com" }`].join("\n") });
    expect(out.recorded).toBe(true);
    expect(calls.filter((c) => c.fn === "create")).toEqual([]);
    for (const [script, input] of [
      ["setContactEmail", `{ email = "a@example.com", idempotencyKey = "${KEY}" }`],
      ["setNotices", `{ maintenance = false, idempotencyKey = "${KEY}" }`],
      ["removeContactEmail", `{ idempotencyKey = "${KEY}" }`],
    ]) {
      const r = run(script, input, { setup: off });
      expect([script, r.out.error]).toEqual([script, "EmailNotConfigured"]);
      expect(r.calls.filter((c) => c.fn === "create" || c.fn === "put_record")).toEqual([]);
    }
  });

  it("retries recording a new space, and logs its uri when every try fails", () => {
    const retried = run("syncAccount", SYNC, { setup: "__put_space_failures = 2" });
    expect(retried.account.preferences_space).toBe(SPACE);
    const lost = run("syncAccount", SYNC, { setup: "__put_space_failures = 3" });
    expect(lost.out.recorded).toBe(true);
    expect(lost.account.preferences_space).toBeUndefined();
    const logged = lost.log.find((l) => l.message === "a preferences space was created but not recorded");
    expect(logged?.level).toBe("error");
    expect(logged?.fields?.uri).toBe(SPACE);
  });

  it("seeds only when it creates the space, so a later sign-in never writes over the owner", () => {
    // The space exists, recorded, with no contact record: another tab created
    // it (setNotices, say) and the owner set nothing yet. A sign-in leaves it.
    const { calls } = run("syncAccount", SYNC, {
      setup: [recorded, `__space_exists = true`, `__pds = { email = "pds@example.com" }`].join("\n"),
    });
    expect(calls.filter((c) => c.fn === "put_record")).toEqual([]);
  });

  it("a space that exists but was never recorded is logged, and the sign-in still succeeds", () => {
    const { out, log, account } = run("syncAccount", SYNC, { setup: "__space_exists = true" });
    expect(out.recorded).toBe(true);
    expect(account.preferences_space).toBeUndefined();
    expect(JSON.stringify(log)).toContain("could not create the preferences space");
  });

  it("no log line names the address", () => {
    const { log } = run("syncAccount", SYNC, {
      setup: [`__pds = { email = "secret-addr@example.com" }`, `__fail["put /v1/account/preferences-space"] = { 502, "Bad" }`].join("\n"),
    });
    expect(JSON.stringify(log)).not.toContain("secret-addr");
  });
});

describe("getContact", () => {
  it("answers the defaults before the space exists, creating nothing", () => {
    const { out, calls } = run("getContact", "{}");
    expect(out).toEqual({ enabled: true, verified: false, maintenance: true });
    expect(calls.filter((c) => c.fn === "create")).toEqual([]);
  });

  it("says when contact email is switched off", () => {
    const { out } = run("getContact", "{}", { setup: "__email_on = false" });
    expect(out).toEqual({ enabled: false, verified: false, maintenance: true });
  });

  it("reports both addresses and whether each is proven", () => {
    const { out } = run("getContact", "{}", {
      setup: [recorded, contact(`{ email = "old@example.com", pendingEmail = "new@example.com" }`), proven("old@example.com"),
        `__records["at.happyproto.preferences.notices"] = { maintenance = false }`].join("\n"),
    });
    expect(out).toEqual({
      enabled: true,
      email: "old@example.com",
      verified: true,
      pendingEmail: "new@example.com",
      pendingVerified: false,
      maintenance: false,
    });
  });

  it("refuses anyone who is neither a customer nor staff", () => {
    const { out } = run("getContact", "{}", { setup: "__customer = false" });
    expect(out.error).toBe("Forbidden");
  });
});

describe("setContactEmail", () => {
  const set = (email: string) => `{ email = "${email}", idempotencyKey = "${KEY}" }`;

  it("a first address is written and sent a link", () => {
    const { out, records, links } = run("setContactEmail", set(" first@example.com "));
    expect(out).toEqual({ sent: true, verified: false, expiresAt: "2026-11-17T00:00:00.000Z" });
    expect(records["at.happyproto.preferences.contact"].email).toBe("first@example.com");
    expect(links).toEqual(["first@example.com"]);
  });

  it("a change waits as pendingEmail, and the old address stays in use", () => {
    const { records, links } = run("setContactEmail", set("new@example.com"), {
      setup: [recorded, contact(`{ email = "old@example.com", source = "pds" }`), proven("old@example.com")].join("\n"),
    });
    const record = records["at.happyproto.preferences.contact"];
    expect([record.email, record.pendingEmail, record.source]).toEqual(["old@example.com", "new@example.com", "pds"]);
    expect(links).toEqual(["new@example.com"]);
  });

  it("the proven address they already have drops a waiting change and sends nothing", () => {
    const { out, records, links } = run("setContactEmail", set("OLD@example.com"), {
      setup: [recorded, contact(`{ email = "old@example.com", pendingEmail = "new@example.com" }`), proven("old@example.com")].join("\n"),
    });
    expect(out).toEqual({ sent: false, verified: true });
    expect(records["at.happyproto.preferences.contact"].pendingEmail).toBeUndefined();
    expect(links).toEqual([]);
  });

  it("an address still waiting for its link is sent it again", () => {
    const { out, links } = run("setContactEmail", set("old@example.com"), {
      setup: [recorded, contact(`{ email = "old@example.com" }`)].join("\n"),
    });
    expect(out.sent).toBe(true);
    expect(links).toEqual(["old@example.com"]);
  });

  it("refuses garbage before anything is written or sent", () => {
    for (const bad of ["", "alice", "a b@example.com"]) {
      const { out, calls, links } = run("setContactEmail", set(bad));
      expect([bad, out.error]).toEqual([bad, "InvalidEmail"]);
      expect(calls.filter((c) => c.fn === "put_record")).toEqual([]);
      expect(links).toEqual([]);
    }
  });

  it("passes the provisioner's refusals through", () => {
    const { out } = run("setContactEmail", set("a@example.com"), {
      setup: `__fail["post /v1/account/contact-email/verification"] = { 429, "TooManyLinks" }`,
    });
    expect(out.error).toBe("TooManyLinks");
  });
});

describe("confirmContactEmail", () => {
  it("proves the link's address and promotes the waiting change", () => {
    const { out, records } = run("confirmContactEmail", `{ token = "tok", idempotencyKey = "${KEY}" }`, {
      setup: [recorded, contact(`{ email = "old@example.com", pendingEmail = "new@example.com" }`), `__links = { "new@example.com" }`].join("\n"),
    });
    expect(out).toEqual({ confirmed: true });
    expect(records["at.happyproto.preferences.contact"].email).toBe("new@example.com");
  });

  it("passes an expired link through", () => {
    const { out } = run("confirmContactEmail", `{ token = "tok", idempotencyKey = "${KEY}" }`, {
      setup: `__fail["post /v1/account/contact-email/confirm"] = { 400, "ExpiredLink" }`,
    });
    expect(out.error).toBe("ExpiredLink");
  });
});

describe("removeContactEmail", () => {
  it("keeps a record without an address and forgets every proof", () => {
    const { out, records, calls } = run("removeContactEmail", `{ idempotencyKey = "${KEY}" }`, {
      setup: [recorded, contact(`{ email = "old@example.com" }`), proven("old@example.com")].join("\n"),
    });
    expect(out).toEqual({ removed: true });
    const record = records["at.happyproto.preferences.contact"];
    expect([record.email, record.source]).toEqual([undefined, "owner"]);
    expect(calls.some((c) => c.fn === "delete" && c.url.endsWith("/v1/account/email-proofs"))).toBe(true);
  });
});

describe("setNotices", () => {
  it("writes the switch to the space", () => {
    const { out, records } = run("setNotices", `{ maintenance = false, idempotencyKey = "${KEY}" }`);
    expect(out).toEqual({ maintenance: false });
    expect(records["at.happyproto.preferences.notices"].maintenance).toBe(false);
  });

  it("refuses anything but a boolean", () => {
    const { out } = run("setNotices", `{ maintenance = "no", idempotencyKey = "${KEY}" }`);
    expect(out.error).toBe("InvalidRequest");
  });
});
