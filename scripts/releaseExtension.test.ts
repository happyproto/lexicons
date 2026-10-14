/**
 * `fileExtensions` on the release extension: the lexicon accepts it, and the
 * registry's one release check (`release_problem`, shared by the indexer and
 * publishRelease) refuses a malformed one while still accepting a release
 * that predates it.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Lexicons } from "@atproto/lexicon";
import { generated, it, run } from "./procedure";

const NSID = "at.happyproto.plugin.releaseExtension";
const lexicons = new Lexicons([
  JSON.parse(await readFile("lexicons/at/happyproto/plugin/releaseExtension.json", "utf8")),
]);

describe("the lexicon", () => {
  test("takes fileExtensions as a short list of short strings", () => {
    const base = { pluginType: "interpreter", apiVersion: "2", languageId: "lua", capabilities: [] };
    expect(lexicons.validate(NSID, { ...base, fileExtensions: ["lua"] }).success).toBe(true);
    expect(lexicons.validate(NSID, base).success).toBe(true);
    expect(lexicons.validate(NSID, { ...base, fileExtensions: ["x".repeat(17)] }).success).toBe(false);
    expect(lexicons.validate(NSID, { ...base, fileExtensions: Array(9).fill("js") }).success).toBe(false);
  });
});

const SCRIPT = await generated("src/at/happyproto/registry/publishRelease.lua");

const STUBS = String.raw`
package.preload["happyview.record"] = function()
  return {
    validate = function() return true end,
    create = function(collection, body, opts)
      return { uri = "at://did:plc:pub/" .. collection .. "/" .. opts.rkey, cid = "bafy" }
    end,
  }
end
package.preload["happyview.db"] = function()
  return {
    get = function(uri)
      if uri == "at://did:plc:pub/at.happyproto.plugin.profile/lua" then return { uri = uri } end
      return nil
    end,
  }
end
package.preload["happyview.atproto"] = function() return {} end
`;

const CTX = `{ caller_did = "did:plc:pub", env = { HAPPYPROTO_DID = "did:plc:hp" } }`;

function release(fileExtensions: string, pluginType = "interpreter"): string {
  const type =
    pluginType === "library"
      ? `pluginType = "library", namespace = "happyview.lua",`
      : `pluginType = "interpreter", languageId = "lua",`;
  return String.raw`{
  validateOnly = true,
  record = {
    ["$type"] = "at.happyproto.plugin.release",
    package = "lua",
    version = "1.0.0",
    artifacts = { package = { url = "https://example.com/m.wasm", checksum = "bogus" } },
    extensions = {
      ["at.happyproto.plugin.releaseExtension"] = {
        ${type}
        apiVersion = "2",
        capabilities = {},
        ${fileExtensions}
      },
    },
  },
}`;
}

describe("the registry's release check", () => {
  it("accepts an interpreter with file extensions, and one without", () => {
    for (const field of [`fileExtensions = { "lua" },`, `fileExtensions = { "lua", "luau" },`, ""]) {
      const { out } = run(SCRIPT, STUBS, release(field), CTX);
      expect(out).toMatchObject({ valid: true });
    }
  });

  it("refuses file extensions that are not a list of short lowercase names", () => {
    for (const field of [
      `fileExtensions = "lua",`,
      `fileExtensions = { ".lua" },`,
      `fileExtensions = { "LUA" },`,
      `fileExtensions = { "${"x".repeat(17)}" },`,
      `fileExtensions = { a = "lua" },`,
      `fileExtensions = { "a", "b", "c", "d", "e", "f", "g", "h", "i" },`,
      `fileExtensions = { "json" },`,
      `fileExtensions = { "lua", "lua" },`,
    ]) {
      const { out } = run(SCRIPT, STUBS, release(field), CTX);
      expect(out).toMatchObject({ error: "InvalidRecord" });
      expect(out.message).toContain("fileExtensions");
    }
  });

  it("ignores fileExtensions on a plugin that is not an interpreter", () => {
    const { out } = run(SCRIPT, STUBS, release(`fileExtensions = "nonsense",`, "library"), CTX);
    expect(out).toMatchObject({ valid: true });
  });
});
