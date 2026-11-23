/**
 * actor.acceptTerms, executed: which provisioner route it takes, and how the
 * signup route's refusals come back (HAP-509). Generated from source as
 * `bun run gen` does and run under Lua 5.4 against stub modules.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const SOURCE = "src/at/happyproto/actor/acceptTerms.lua";
async function generated(): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(SOURCE, "utf8");
  const blocks = expand(parseDirective(text, SOURCE), [...prelude.keys()]);
  return render(SOURCE, blocks.map((name) => prelude.get(name)!), text);
}
const SCRIPT = await generated();

const HP = "did:plc:hp";
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const ADMINS = `at://${HP}/space/at.happyproto.admin/main`;
const KEY = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const INPUT = `{ termsVersion = "beta-2026-11", textVersion = "v1", text = "I agree", idempotencyKey = "${KEY}" }`;
const env = (signup: string) => `{
  HAPPYPROTO_DID = "${HP}",
  PROVISIONER_URL = "http://provisioner:8080/",
  PROVISIONER_TOKEN = "tok",
  HAPPYPROTO_SIGNUP = ${signup},
}`;

function run({
  signup = '"open"',
  access = "nil",
  reply = `return { status = 200, body = '{"ok":1}', headers = {} }`,
} = {}): { out: any; calls: any[] } {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so acceptTerms was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    SCRIPT,
    `__access = function(uri, did) return ${access} end`,
    `__decoded['{"ok":1}'] = { terms_version = "beta-2026-11", terms_accepted = true }`,
    `__decoded['{"closed":1}'] = { error = "SignupsClosed", message = "signup is closed" }`,
    `__decoded['{"paused":1}'] = { error = "SignupsPaused", message = "signups are paused for this hour; try again later" }`,
    `__decoded['{"suspended":1}'] = { error = "AccountSuspended", message = "this account is suspended" }`,
    `__reply = function(method, url, opts) ${reply} end`,
    `local out = handle(${INPUT}, { caller_did = "did:plc:alice", env = ${env(signup)} })`,
    `io.write(__encode({ out = out, calls = __calls }))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return { out: parsed.out, calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
}

const posted = (calls: any[]) => calls.filter((c) => c.fn === "post").map((c) => c.url);

describe("actor.acceptTerms", () => {
  it("while open, someone outside the customers space signs up", () => {
    const { out, calls } = run();
    expect(out).toEqual({ termsVersion: "beta-2026-11", accepted: true });
    expect(posted(calls)).toEqual(["http://provisioner:8080/v1/account/signup"]);
  });

  it("a member of the customers space, or staff, only accepts the terms", () => {
    for (const access of [`uri == "${CUSTOMERS}" and "read" or nil`, `uri == "${ADMINS}" and "write" or nil`]) {
      expect(posted(run({ access }).calls)).toEqual(["http://provisioner:8080/v1/account/terms"]);
    }
  });

  it("while closed, someone outside the space is refused and nothing is sent", () => {
    const { out, calls } = run({ signup: "nil" });
    expect(out.error).toBe("Forbidden");
    expect(posted(calls)).toEqual([]);
  });

  it("passes the signup route's refusals through", () => {
    const cases: [string, number, string][] = [
      ['{"closed":1}', 403, "SignupsClosed"],
      ['{"paused":1}', 429, "SignupsPaused"],
      ['{"suspended":1}', 403, "AccountSuspended"],
    ];
    for (const [body, status, code] of cases) {
      const { out } = run({ reply: `return { status = ${status}, body = '${body}', headers = {} }` });
      expect(out.error).toBe(code);
    }
  });
});
