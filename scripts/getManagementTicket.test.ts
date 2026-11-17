/**
 * server.getManagementTicket, executed. Generated from source as `bun run gen`
 * does and run under Lua 5.4 against stub modules, to pin down that the key
 * proof reaches HappyView untouched, that the assertion HappyView signs is what
 * goes to the provisioner, and how refusals come back.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const SOURCE = "src/at/happyproto/server/getManagementTicket.lua";

async function generated(): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(SOURCE, "utf8");
  const blocks = expand(parseDirective(text, SOURCE), [...prelude.keys()]);
  return render(SOURCE, blocks.map((name) => prelude.get(name)!), text);
}
const SCRIPT = await generated();

const HP = "did:plc:hp";
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const ID = "4f0c2e3a-1b2c-4d5e-8f90-123456789abc";
const PROOF = "proof.header.sig";
const ENV = `{
  HAPPYPROTO_DID = "${HP}",
  PROVISIONER_URL = "http://provisioner:8080/",
  PROVISIONER_TOKEN = "tok",
  PROVISIONER_AUDIENCE = "https://provisioner.example",
}`;

/**
 * `assertion` is a Lua function body over (audience, proof) standing in for
 * HappyView's ctx.caller_assertion; the default signs and records its
 * arguments.
 */
function run({
  input = `{ instance = "${ID}", keyProof = "${PROOF}" }`,
  env = ENV,
  assertion = `return "assertion-token", nil`,
  reply = `return { status = 200, body = '{"t":1}', headers = {} }`,
} = {}): { out: any; calls: any[] } {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so getManagementTicket was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    SCRIPT,
    `__access = function(uri, did) return (uri == "${CUSTOMERS}") and "write" or nil end`,
    `__decoded['{"t":1}'] = { ticket = "the-ticket", expires_at = 1800000060, audience = "hpy:instance:${ID}", url = "https://alice.example" }`,
    `__decoded['{"e":1}'] = { error = "TicketsDisabled", message = "management tickets are not turned on" }`,
    `__reply = function(method, url, opts) ${reply} end`,
    `local ctx = { caller_did = "did:plc:alice", env = ${env} }`,
    `ctx.caller_assertion = function(audience, proof)
       __calls[#__calls + 1] = { fn = "caller_assertion", audience = audience, proof = proof }
       ${assertion}
     end`,
    `local out = handle(${input}, ctx)`,
    `io.write(__encode({ out = out, calls = __calls }))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return { out: parsed.out, calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
}

const called = (calls: any[], fn: string) => calls.filter((c) => c.fn === fn);

describe("getManagementTicket", () => {
  it("passes the key proof to HappyView and the assertion to the provisioner", () => {
    const { out, calls } = run();
    expect(out).toEqual({
      ticket: "the-ticket",
      expiresAt: 1800000060,
      audience: `hpy:instance:${ID}`,
      url: "https://alice.example",
    });
    expect(called(calls, "caller_assertion")).toEqual([
      { fn: "caller_assertion", audience: "https://provisioner.example", proof: PROOF },
    ]);
    const posts = called(calls, "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`http://provisioner:8080/v1/tenants/${ID}/management-ticket`);
    expect(posts[0].opts.headers["HV-Caller-Assertion"]).toBe("assertion-token");
  });

  it("needs a key proof, and asks for nothing without one", () => {
    for (const input of [`{ instance = "${ID}" }`, `{ instance = "${ID}", keyProof = "" }`, `{ instance = "${ID}", keyProof = 7 }`]) {
      const { out, calls } = run({ input });
      expect(out.error).toBe("InvalidRequest");
      expect(called(calls, "caller_assertion")).toHaveLength(0);
      expect(called(calls, "post")).toHaveLength(0);
    }
  });

  it("a refused key proof is the caller's to fix; any other refusal means signing in again", () => {
    const refusedProof = run({ assertion: `return nil, "the key proof was refused: bad signature"` });
    expect(refusedProof.out.error).toBe("InvalidRequest");
    expect(called(refusedProof.calls, "post")).toHaveLength(0);

    const notDpop = run({ assertion: `return nil, "a caller assertion needs a caller who authenticated with DPoP"` });
    expect(notDpop.out.error).toBe("Unavailable");
    expect(called(notDpop.calls, "post")).toHaveLength(0);
  });

  it("an instance id that isn't a UUID never reaches HappyView or the provisioner", () => {
    const { out, calls } = run({ input: `{ instance = "../x", keyProof = "${PROOF}" }` });
    expect(out.error).toBe("InvalidRequest");
    expect(calls.filter((c) => c.fn !== "access")).toHaveLength(0);
  });

  it("is Upstream when the provisioner's audience isn't configured", () => {
    const { out, calls } = run({ env: `{ HAPPYPROTO_DID = "${HP}" }` });
    expect(out.error).toBe("Upstream");
    expect(called(calls, "caller_assertion")).toHaveLength(0);
  });

  it("passes the provisioner's own refusals through", () => {
    const { out } = run({ reply: `return { status = 404, body = '{"e":1}', headers = {} }` });
    expect(out.error).toBe("TicketsDisabled");
  });
});
