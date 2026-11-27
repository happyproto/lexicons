/**
 * admin.notifyCapacityQueue, executed (HAP-511): who is sent, what's kept
 * back, and that no address reaches the reply or a log. Generated from source
 * as `bun run gen` does and run under Lua 5.4 against stub modules.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const SOURCE = "src/at/happyproto/admin/notifyCapacityQueue.lua";
const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
const text = await readFile(SOURCE, "utf8");
const SCRIPT = render(SOURCE, expand(parseDirective(text, SOURCE), [...prelude.keys()]).map((b) => prelude.get(b)!), text);

const HP = "did:plc:hp";
const ADMINS = `at://${HP}/space/at.happyproto.admin/main`;
const KEY = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const ENV = `{ HAPPYPROTO_DID = "${HP}", PROVISIONER_URL = "http://provisioner:8080/", PROVISIONER_TOKEN = "tok" }`;

/** `n` waiting owners did:plc:o1..on, each with a space at:space/oN. */
function waits(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `{ did = "did:plc:o${i + 1}", plan = "small", preferences_space = "at://space/o${i + 1}" }`);
  return `{ waits = { ${rows.join(", ")} } }`;
}

function run({
  list = waits(2),
  records = `local who = uri:match("o(%d+)$"); return { records = { { rkey = "self", author_did = "did:plc:o" .. who, record = { email = "o" .. who .. "@example.com" } } } }`,
  notify = `{ results = { { did = "did:plc:o1", outcome = "sent" }, { did = "did:plc:o2", outcome = "sent" } } }`,
  notifyStatus = 200,
} = {}): { out: any; calls: any[]; log: any[] } {
  if (!lua) throw new Error("no lua on PATH; set ALLOW_SKIP_LUA=1 to skip deliberately");
  const source = [
    HARNESS,
    SCRIPT,
    `__access = function(uri, did) return uri == "${ADMINS}" and "write" or nil end`,
    `__records = function(uri, opts) ${records} end`,
    `__decoded['{"list":1}'] = ${list}`,
    `__decoded['{"notify":1}'] = ${notify}`,
    `__reply = function(method, url, opts)
       if method == "get" then return { status = 200, body = '{"list":1}', headers = {} } end
       return { status = ${notifyStatus}, body = '{"notify":1}', headers = {} }
     end`,
    `local out = handle({ idempotencyKey = "${KEY}" }, { caller_did = "did:plc:staff", env = ${ENV} })`,
    `io.write(__encode({ out = out, calls = __calls, log = __log }))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  const list_ = (v: unknown) => (Array.isArray(v) ? v : []);
  return { out: parsed.out, calls: list_(parsed.calls), log: list_(parsed.log) };
}

const posts = (calls: any[]) => calls.filter((c) => c.fn === "post");

describe("admin.notifyCapacityQueue", () => {
  it("sends each due owner's own address in one batch, and no address comes back", () => {
    const { out, calls, log } = run();
    expect(out).toEqual({ sent: 2, noContact: 0, notVerified: 0, unreadable: 0, failed: 0, remaining: 0 });
    const [post] = posts(calls);
    expect(post.url).toBe("http://provisioner:8080/v1/admin/capacity-waits/notify");
    expect(post.opts.headers["Idempotency-Key"]).toBe(KEY);
    expect(JSON.stringify(out) + JSON.stringify(log)).not.toContain("@example.com");
  });

  it("takes at most 15 a press and counts the rest as remaining", () => {
    const { out, calls } = run({ list: waits(20), notify: "{ results = {} }" });
    expect(out.remaining).toBe(5);
    expect(calls.filter((c) => c.fn === "records")).toHaveLength(15);
  });

  it("only the owner's own record counts, and an unreadable space is counted apart", () => {
    const { out } = run({
      records: `if uri:match("o1$") then error("space gone") end
        return { records = { { rkey = "self", author_did = "did:plc:someoneelse", record = { email = "x@example.com" } } } }`,
    });
    expect(out).toMatchObject({ unreadable: 1, noContact: 1, sent: 0 });
  });

  it("a full budget is remaining with retryAt; refusals are counted", () => {
    const { out } = run({
      notify: `{ results = { { did = "did:plc:o1", outcome = "not_verified" }, { did = "did:plc:o2", outcome = "over_budget", retry_at = "2026-12-07T16:00:00Z" } } }`,
    });
    expect(out).toMatchObject({ notVerified: 1, remaining: 1, retryAt: "2026-12-07T16:00:00Z" });
  });

  it("says when owner email is off", () => {
    const { out } = run({ notifyStatus: 503, notify: `{ error = "EmailNotConfigured", message = "owner email is switched off" }` });
    expect(out.error).toBe("EmailNotConfigured");
  });
});
