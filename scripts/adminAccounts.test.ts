/**
 * admin.getAccount, admin.suspendAccount and admin.unsuspendAccount,
 * executed (HAP-511): the gate, input checks, and how the provisioner's
 * replies come back. Generated from source as `bun run gen` does and run
 * under Lua 5.4 against stub modules.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
async function script(name: string): Promise<string> {
  const source = `src/at/happyproto/admin/${name}.lua`;
  const text = await readFile(source, "utf8");
  const blocks = expand(parseDirective(text, source), [...prelude.keys()]);
  return render(source, blocks.map((b) => prelude.get(b)!), text);
}
const SCRIPTS = {
  getAccount: await script("getAccount"),
  suspendAccount: await script("suspendAccount"),
  unsuspendAccount: await script("unsuspendAccount"),
};

const HP = "did:plc:hp";
const ADMINS = `at://${HP}/space/at.happyproto.admin/main`;
const KEY = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const ENV = `{ HAPPYPROTO_DID = "${HP}", PROVISIONER_URL = "http://provisioner:8080/", PROVISIONER_TOKEN = "tok" }`;

function run(
  name: keyof typeof SCRIPTS,
  input: string,
  { staff = true, reply = `return { status = 200, body = '{"ok":1}', headers = {} }`, decoded = "{}" } = {},
): { out: any; calls: any[] } {
  if (!lua) throw new Error("no lua on PATH; set ALLOW_SKIP_LUA=1 to skip deliberately");
  const source = [
    HARNESS,
    SCRIPTS[name],
    `__access = function(uri, did) return (${staff} and uri == "${ADMINS}") and "write" or nil end`,
    `__decoded['{"ok":1}'] = ${decoded}`,
    `__reply = function(method, url, opts) ${reply} end`,
    `local out = handle(${input}, { caller_did = "did:plc:staff", env = ${ENV} })`,
    `io.write(__encode({ out = out, calls = __calls }))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return { out: parsed.out, calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
}

const http = (calls: any[]) => calls.filter((c) => c.fn !== "access");

describe("staff account scripts", () => {
  it("refuse anyone not staff before calling the provisioner", () => {
    for (const [name, input] of [
      ["getAccount", `{ did = "did:plc:x" }`],
      ["suspendAccount", `{ did = "did:plc:x", reason = "spam", idempotencyKey = "${KEY}" }`],
      ["unsuspendAccount", `{ did = "did:plc:x", idempotencyKey = "${KEY}" }`],
    ] as const) {
      const { out, calls } = run(name, input, { staff: false });
      expect(out.error).toBe("Forbidden");
      expect(http(calls)).toEqual([]);
    }
  });

  it("suspendAccount trims the reason, checks its length, and encodes the DID", () => {
    const ok = run("suspendAccount", `{ did = "did:web:a.example%3A8080", reason = "  spam  ", idempotencyKey = "${KEY}" }`, {
      decoded: "{ suspended = true, stopped = 2 }",
    });
    expect(ok.out).toEqual({ stopped: 2 });
    const [post] = http(ok.calls);
    expect(post.url).toBe("http://provisioner:8080/v1/admin/accounts/did%3Aweb%3Aa.example%253A8080/suspend");
    for (const reason of ['"   "', `"${"x".repeat(501)}"`, "nil"]) {
      const bad = run("suspendAccount", `{ did = "did:plc:x", reason = ${reason}, idempotencyKey = "${KEY}" }`);
      expect(bad.out.error).toBe("InvalidRequest");
      expect(http(bad.calls)).toEqual([]);
    }
    expect(run("suspendAccount", `{ did = "nope", reason = "spam", idempotencyKey = "${KEY}" }`).out.error).toBe(
      "InvalidRequest",
    );
    expect(run("unsuspendAccount", `{ did = "did:plc:x" }`).out.error).toBe("InvalidRequest");
  });

  it("suspendAccount says so when the account is staff", () => {
    const { out } = run("suspendAccount", `{ did = "did:plc:x", reason = "spam", idempotencyKey = "${KEY}" }`, {
      reply: `return { status = 400, body = '{"ok":1}', headers = {} }`,
      decoded: `{ error = "CannotSuspendStaff", message = "a staff account can't be suspended" }`,
    });
    expect(out.error).toBe("CannotSuspendStaff");
  });

  it("getAccount answers Upstream for a reply missing what its output requires", () => {
    const good = run("getAccount", `{ did = "did:plc:x" }`, {
      decoded: `{ account = { did = "did:plc:x", cohort = "open_beta", created_at = "2026-12-07T15:00:00Z", instance_count = 1 } }`,
    });
    expect(good.out).toEqual({ did: "did:plc:x", cohort: "open_beta", createdAt: "2026-12-07T15:00:00Z", instanceCount: 1 });
    const bad = run("getAccount", `{ did = "did:plc:x" }`, { decoded: `{ account = { did = "did:plc:x" } }` });
    expect(bad.out.error).toBe("Upstream");
  });
});
