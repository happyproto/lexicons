/**
 * registry.publishProfile and registry.publishRelease, executed. The scripts
 * are generated from source exactly as `bun run gen` does and run under Lua
 * 5.4 behind a recording record stub. The integration suite cannot reach a
 * real write -- its accounts hold no OAuth session -- so what each procedure
 * asks HappyView to send to the PDS is proven here.
 */
import { describe, expect } from "bun:test";
import { generated, it, run as runProcedure } from "./procedure";

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
      if uri == __tombstone then return { uri = uri, record = { status = "deleted" } } end
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

function run(script: string, input: string) {
  return runProcedure(script, STUBS, input, CTX);
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

// Withdrawing a version tombstones its state row, and the indexer refuses that
// version for good. The release row itself may be gone from the index -- an
// instance that ran an earlier withdrawRelease dropped it -- so the tombstone is
// what the refusal reads.
describe("a withdrawn version", () => {
  it("is refused by publishRelease as VersionExists, even as a dry run", () => {
    const tombstone =
      "at://did:plc:hp/at.happyproto.registry.releaseState/did:plc:pub:probe:1.0.0";
    for (const input of [RELEASE, RELEASE.replace("{\n  record", "{\n  validateOnly = true,\n  record")]) {
      const { out, calls } = runProcedure(
        RELEASE_SCRIPT,
        STUBS + `__tombstone = "${tombstone}"`,
        input,
        CTX,
      );
      expect(out).toMatchObject({ error: "VersionExists" });
      expect(out.message).toContain("withdrawn");
      expect(calls).toEqual([]);
    }
  });
});
