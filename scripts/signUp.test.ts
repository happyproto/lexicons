/**
 * actor.signUp, executed. Generated from source as `bun run gen` does and run
 * under Lua 5.4 against stub modules, to pin down when signup is open, that
 * the provisioner is asked before anything is joined, and how refusals come
 * back.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const SOURCE = "src/at/happyproto/actor/signUp.lua";

async function generated(): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(SOURCE, "utf8");
  const blocks = expand(parseDirective(text, SOURCE), [...prelude.keys()]);
  return render(SOURCE, blocks.map((name) => prelude.get(name)!), text);
}
const SCRIPT = await generated();

const HP = "did:plc:hp";
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const KEY = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const TOKEN = "abcdef0123456789";
const OPEN = `{
  HAPPYPROTO_DID = "${HP}",
  PROVISIONER_URL = "http://provisioner:8080/",
  PROVISIONER_TOKEN = "tok",
  HAPPYPROTO_SIGNUP = "open",
  HAPPYPROTO_SIGNUP_INVITE = "${TOKEN}",
}`;
const INPUT = `{ termsVersion = "beta-2026-11", textVersion = "v1", text = "I agree", idempotencyKey = "${KEY}" }`;

function run({
  input = INPUT,
  env = OPEN,
  member = false,
  reply = `return { status = 200, body = '{"ok":1}', headers = {} }`,
  accept = `return { uri = "${CUSTOMERS}" }`,
} = {}): { out: any; calls: any[]; log: any[] } {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so signUp was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    SCRIPT,
    `__access = function(uri, did) return (${member} and uri == "${CUSTOMERS}") and "read" or nil end`,
    `__decoded['{"ok":1}'] = { cohort = "open_beta", terms_version = "beta-2026-11", terms_accepted = true }`,
    `__decoded['{"paused":1}'] = { error = "SignupsPaused", message = "signups are paused for this hour; try again later", details = { window = "hour" } }`,
    `__decoded['{"suspended":1}'] = { error = "AccountSuspended", message = "this account is suspended" }`,
    `__decoded['{"outdated":1}'] = { error = "TermsOutdated", message = "the beta terms have changed; reload and accept the current ones" }`,
    `__reply = function(method, url, opts) ${reply} end`,
    `__accept = function(token) ${accept} end`,
    `local ctx = { caller_did = "did:plc:alice", env = ${env} }`,
    `local out = handle(${input}, ctx)`,
    `io.write(__encode({ out = out, calls = __calls, log = __log }))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return { out: parsed.out, calls: list(parsed.calls), log: list(parsed.log) };
}

const called = (calls: any[], fn: string) => calls.filter((c) => c.fn === fn);

describe("actor.signUp", () => {
  it("asks the provisioner, then joins through the standing invite", () => {
    const { out, calls } = run();
    expect(out).toEqual({ isCustomer: true, joined: true, termsVersion: "beta-2026-11" });
    const posts = called(calls, "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("http://provisioner:8080/v1/account/signup");
    expect(posts[0].opts.headers["Idempotency-Key"]).toBe(KEY);
    const joins = called(calls, "accept_invite");
    expect(joins).toEqual([{ fn: "accept_invite", token: TOKEN }]);
    // The provisioner is asked before anything is joined.
    expect(calls.findIndex((c) => c.fn === "post")).toBeLessThan(
      calls.findIndex((c) => c.fn === "accept_invite"),
    );
  });

  it("is closed unless HAPPYPROTO_SIGNUP is open and the invite is set", () => {
    for (const env of [
      `{ HAPPYPROTO_DID = "${HP}", HAPPYPROTO_SIGNUP_INVITE = "${TOKEN}" }`,
      `{ HAPPYPROTO_DID = "${HP}", HAPPYPROTO_SIGNUP = "Open", HAPPYPROTO_SIGNUP_INVITE = "${TOKEN}" }`,
      `{ HAPPYPROTO_DID = "${HP}", HAPPYPROTO_SIGNUP = "open" }`,
      `{ HAPPYPROTO_DID = "${HP}", HAPPYPROTO_SIGNUP = "open", HAPPYPROTO_SIGNUP_INVITE = "not hex" }`,
    ]) {
      const { out, calls } = run({ env });
      expect(out.error).toBe("SignupClosed");
      expect(calls).toEqual([]);
    }
  });

  it("records only the terms for a caller who is already a customer", () => {
    const { out, calls } = run({ member: true });
    expect(out).toEqual({ isCustomer: true, joined: false, termsVersion: "beta-2026-11" });
    expect(called(calls, "post")[0].url).toBe("http://provisioner:8080/v1/account/terms");
    expect(called(calls, "accept_invite")).toEqual([]);
  });

  it("joins nothing when the provisioner refuses", () => {
    const cases: [string, number, string][] = [
      ['{"paused":1}', 429, "SignupsPaused"],
      ['{"suspended":1}', 403, "AccountSuspended"],
      ['{"outdated":1}', 400, "TermsOutdated"],
    ];
    for (const [body, status, code] of cases) {
      const { out, calls } = run({ reply: `return { status = ${status}, body = '${body}', headers = {} }` });
      expect(out.error).toBe(code);
      expect(called(calls, "accept_invite")).toEqual([]);
    }
  });

  it("treats a member race as joined, and a refused invite as ours to fix", () => {
    expect(run({ accept: `error("CONFLICT - already a member")` }).out).toEqual({
      isCustomer: true,
      joined: false,
      termsVersion: "beta-2026-11",
    });
    const refused = run({ accept: `error("BAD_INPUT - invite has expired")` });
    expect(refused.out.error).toBe("Upstream");
    expect(refused.log.some((l) => l.level === "warn")).toBe(true);
    const elsewhere = run({ accept: `return { uri = "at://did:plc:x/space/at.happyproto.customers/main" }` });
    expect(elsewhere.out.error).toBe("Upstream");
  });

  it("checks its input before anything else", () => {
    expect(run({ input: `{ termsVersion = "beta-2026-11", textVersion = "v1", text = "I agree" }` }).out.error).toBe(
      "InvalidRequest",
    );
    const { out, calls } = run({ input: `{ idempotencyKey = "${KEY}" }` });
    expect(out.error).toBe("InvalidRequest");
    expect(calls).toEqual([]);
  });
});
