/**
 * registry.publishProfile and registry.publishRelease, executed. The scripts
 * are generated from source exactly as `bun run gen` does and run under Lua
 * 5.4 behind a recording record stub. The integration suite cannot reach a
 * real write -- its accounts hold no OAuth session -- so what each procedure
 * asks HappyView to send to the PDS is proven here.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { expand, parseDirective, parsePrelude, render } from "./gen";
import { HARNESS } from "./harness";
import { findLua } from "./lua";

const lua = findLua();
const skipLua = !lua && Boolean(process.env.ALLOW_SKIP_LUA);
const it = skipLua ? test.skip : test;

async function generated(source: string): Promise<string> {
  const prelude = parsePrelude(await readFile("src/shared/prelude.lua", "utf8"));
  const text = await readFile(source, "utf8");
  const blocks = expand(parseDirective(text, source), [...prelude.keys()]);
  return render(source, blocks.map((name) => prelude.get(name)!), text);
}
const PROFILE_SCRIPT = await generated("src/at/happyproto/registry/publishProfile.lua");
const RELEASE_SCRIPT = await generated("src/at/happyproto/registry/publishRelease.lua");

/**
 * A record library that accepts every record and remembers each create, and
 * an index in which the publisher's profile exists. A create's options
 * become the createRecord body's `validate`, so they are what the PDS sees.
 */
const STUBS = String.raw`
package.preload["happyview.record"] = function()
  return {
    validate = function() return true end,
    create = function(collection, body, opts)
      __calls[#__calls + 1] = { fn = "create", collection = collection, opts = opts }
      return { uri = "at://did:plc:pub/" .. collection .. "/" .. opts.rkey, cid = "bafy" }
    end,
  }
end
package.preload["happyview.db"] = function()
  return {
    get = function(uri)
      if uri == "at://did:plc:pub/at.happyproto.plugin.profile/probe" then return { uri = uri } end
      return nil
    end,
  }
end
package.preload["happyview.atproto"] = function() return {} end
`;

const CTX = `{ caller_did = "did:plc:pub", env = { HAPPYPROTO_DID = "did:plc:hp" } }`;

const PROFILE = String.raw`{
  slug = "probe",
  record = {
    ["$type"] = "at.happyproto.plugin.profile",
    type = "happyview-plugin",
    name = "Probe",
    license = "MIT",
    authors = { "HappyProto <integration@example.com>" },
    security = { "mailto:integration@example.com" },
  },
}`;

const RELEASE = String.raw`{
  record = {
    ["$type"] = "at.happyproto.plugin.release",
    package = "probe",
    version = "1.0.0",
    artifacts = { package = { url = "https://example.com/m.wasm", checksum = "bogus" } },
    extensions = {
      ["at.happyproto.plugin.releaseExtension"] = {
        pluginType = "library",
        apiVersion = "2",
        capabilities = {},
        namespace = "happyview.demo",
      },
    },
  },
}`;

type Run = { out: any; calls: any[] };

function run(script: string, input: string): Run {
  if (!lua) {
    throw new Error(
      "no lua on PATH, so the publish procedures were never executed. " +
        "Install Lua (macOS: brew install lua; Ubuntu: apt-get install -y lua5.4). " +
        "To run deliberately without it, set ALLOW_SKIP_LUA=1.",
    );
  }
  const source = [
    HARNESS,
    STUBS,
    script,
    `local __out = handle(${input}, ${CTX})`,
    "io.write(__encode({ out = __out, calls = __calls }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  return { out: parsed.out, calls };
}

// A PDS has never heard of at.happyproto.*: asked to validate against the
// lexicon, it answers `InvalidRecord: Lexicon not found` and the write fails.
// Both procedures validate the record themselves first, so they must ask the
// PDS not to.
describe("a publish writes without asking the PDS to validate", () => {
  it("publishProfile", () => {
    const { out, calls } = run(PROFILE_SCRIPT, PROFILE);
    expect(out).toMatchObject({ valid: true, uri: "at://did:plc:pub/at.happyproto.plugin.profile/probe" });
    expect(calls).toEqual([
      { fn: "create", collection: "at.happyproto.plugin.profile", opts: { rkey: "probe", validate: false } },
    ]);
  });

  it("publishRelease", () => {
    const { out, calls } = run(RELEASE_SCRIPT, RELEASE);
    expect(out).toMatchObject({ valid: true, uri: "at://did:plc:pub/at.happyproto.plugin.release/probe:1.0.0" });
    expect(calls).toEqual([
      {
        fn: "create",
        collection: "at.happyproto.plugin.release",
        opts: { rkey: "probe:1.0.0", validate: false },
      },
    ]);
  });
});
