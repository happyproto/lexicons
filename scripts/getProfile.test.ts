/**
 * actor.getProfile, executed. Generated from source as `bun run gen` does and
 * run under Lua 5.4 against stub modules, to pin down what the caller is told
 * about their own entitlements and that nobody else's are ever disclosed.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

const SOURCE = "src/at/happyproto/actor/getProfile.lua";

async function generated(): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(SOURCE, "utf8");
  const blocks = expand(parseDirective(text, SOURCE), [...prelude.keys()]);
  return render(SOURCE, blocks.map((name) => prelude.get(name)!), text);
}
const SCRIPT = await generated();

/** app.bsky.actor.getProfile answers with the DID asked for, or the identifier is a DID already. */
const XRPC = String.raw`
package.preload["happyview.xrpc"] = function()
  return {
    query = function(nsid, params)
      return { did = params.actor, handle = "someone.test" }
    end,
  }
end
`;

const HP = "did:plc:hp";
const ADMIN = `at://${HP}/space/at.happyproto.admin/main`;
const CUSTOMERS = `at://${HP}/space/at.happyproto.customers/main`;
const CTX = `{ caller_did = "did:plc:me", env = { HAPPYPROTO_DID = "${HP}" } }`;

/** `access` is a Lua expression of (uri, did): the stubbed spaces answer. */
function run({ input = "{}", ctx = CTX, access = "nil" } = {}): any {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so getProfile was never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    XRPC,
    SCRIPT,
    `__access = function(uri, did) return ${access} end`,
    `io.write(__encode(handle(${input}, ${ctx})))`,
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

const only = (uri: string, level: string) => `(uri == "${uri}") and "${level}" or nil`;

describe("isCustomer", () => {
  it("is true for a member of the customers space", () => {
    const out = run({ access: only(CUSTOMERS, "write") });
    expect(out).toMatchObject({ isSelf: true, isCustomer: true, isMember: false });
    expect(out).not.toHaveProperty("access");
  });

  it("is false for someone in neither space", () => {
    expect(run()).toMatchObject({ isSelf: true, isCustomer: false, isMember: false });
  });

  it("is false for staff who are not customers, and isMember stays true", () => {
    expect(run({ access: only(ADMIN, "write") })).toMatchObject({
      isCustomer: false,
      isMember: true,
      access: "write",
    });
  });

  it("is true alongside isMember for someone in both", () => {
    expect(run({ access: '"read"' })).toMatchObject({ isCustomer: true, isMember: true, access: "read" });
  });

  it("is false for an access level the allowlist does not admit", () => {
    expect(run({ access: only(CUSTOMERS, "banned") })).toMatchObject({ isCustomer: false });
  });

  it("is false when the space lookup raises, and isMember is unaffected by the customer lookup", () => {
    const out = run({ access: `(uri == "${CUSTOMERS}") and error("spaces off") or "write"` });
    expect(out).toMatchObject({ isCustomer: false, isMember: true });
  });

  it("is false when the whole spaces lookup raises", () => {
    expect(run({ access: 'error("spaces off")' })).toMatchObject({ isCustomer: false, isMember: false });
  });

  it("is false when HAPPYPROTO_DID is unset or malformed", () => {
    for (const env of ["{}", '{ HAPPYPROTO_DID = "" }', '{ HAPPYPROTO_DID = "hp" }']) {
      const out = run({ ctx: `{ caller_did = "did:plc:me", env = ${env} }`, access: '"write"' });
      expect([env, out.isCustomer, out.isMember]).toEqual([env, false, false]);
    }
  });

  it("is never reported for another actor", () => {
    const out = run({ input: '{ actor = "did:plc:other" }', access: '"write"' });
    expect(out).toMatchObject({ did: "did:plc:other", isSelf: false });
    expect(out).not.toHaveProperty("isCustomer");
    expect(out).not.toHaveProperty("isMember");
    expect(out).not.toHaveProperty("access");
  });
});
