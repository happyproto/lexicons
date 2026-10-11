/**
 * registry.updateProfile and registry.withdrawRelease, executed. A publisher
 * edits a profile or withdraws a release through these rather than by calling
 * com.atproto.repo.putRecord or deleteRecord through HappyView, which proxies
 * a method it does not host to wherever the instance's routing says and not
 * necessarily to the caller's PDS. Like the publish procedures, they write
 * through `happyview.record`, which acts as the caller against their own PDS.
 */
import { describe, expect } from "bun:test";
import { generated, it, run as runProcedure } from "./procedure";

const UPDATE_SCRIPT = await generated("src/at/happyproto/registry/updateProfile.lua");
const WITHDRAW_SCRIPT = await generated("src/at/happyproto/registry/withdrawRelease.lua");

/**
 * A record library that accepts every record and remembers each write, and
 * an index holding the publisher's profile `probe` and its release 1.0.0.
 * `__put_error` and `__delete_error`, when set, are raised by the write the
 * way the host raises a PDS refusal.
 */
const STUBS = String.raw`
package.preload["happyview.record"] = function()
  return {
    validate = function() return true end,
    put = function(uri, body, opts)
      __calls[#__calls + 1] = { fn = "put", uri = uri, opts = opts }
      if __put_error then error(__put_error) end
      return { uri = uri, cid = "bafynew" }
    end,
    -- Like the real library, a delete the PDS accepts also leaves the
    -- local index at once.
    delete = function(uri)
      __calls[#__calls + 1] = { fn = "delete", uri = uri }
      if __delete_error then error(__delete_error) end
      __indexed[uri] = nil
    end,
    save_local = function(collection, rkey, body)
      __calls[#__calls + 1] = { fn = "save_local", collection = collection, rkey = rkey, body = body }
      __indexed["at://did:plc:pub/" .. collection .. "/" .. rkey] = body
      return { uri = "at://did:plc:pub/" .. collection .. "/" .. rkey }
    end,
  }
end
__indexed = {
  ["at://did:plc:pub/at.happyproto.plugin.profile/probe"] = { name = "Probe" },
  ["at://did:plc:pub/at.happyproto.plugin.release/probe:1.0.0"] = { package = "probe", version = "1.0.0" },
}
package.preload["happyview.db"] = function()
  return {
    get = function(uri)
      local body = __indexed[uri]
      if body then return { uri = uri, record = body } end
      return nil
    end,
  }
end
package.preload["happyview.atproto"] = function() return {} end
`;

const CTX = `{ caller_did = "did:plc:pub", env = { HAPPYPROTO_DID = "did:plc:hp" } }`;
const ANONYMOUS = `{ env = { HAPPYPROTO_DID = "did:plc:hp" } }`;

function run(script: string, input: string, { ctx = CTX, setup = "" } = {}) {
  return runProcedure(script, STUBS + setup, input, ctx);
}

const RECORD = String.raw`{
  ["$type"] = "at.happyproto.plugin.profile",
  type = "happyview-plugin",
  name = "Probe",
  license = "MIT",
  authors = { "HappyProto <integration@example.com>" },
  security = { "mailto:integration@example.com" },
}`;

function update(slug: string, extra = "", record = RECORD) {
  return `{ slug = "${slug}", record = ${record}${extra} }`;
}

describe("updateProfile", () => {
  it("replaces the caller's profile at its slug, guarded by the CID it was read at", () => {
    const { out, calls } = run(UPDATE_SCRIPT, update("probe", `, swapCid = "bafyold"`));
    expect(out).toEqual({ uri: "at://did:plc:pub/at.happyproto.plugin.profile/probe", cid: "bafynew" });
    // validate = false for the reason publishProfile gives: no PDS knows the
    // at.happyproto.* lexicons, and the record was checked here already.
    expect(calls).toEqual([
      {
        fn: "put",
        uri: "at://did:plc:pub/at.happyproto.plugin.profile/probe",
        opts: { swap_cid: "bafyold", validate: false },
      },
    ]);
  });

  it("refuses a slug with no indexed profile rather than creating one", () => {
    const { out, calls } = run(UPDATE_SCRIPT, update("never-published"));
    expect(out).toMatchObject({ error: "ProfileMissing" });
    expect(calls).toEqual([]);
  });

  it("refuses a profile the indexer would skip, before writing", () => {
    const npm = RECORD.replace(`"happyview-plugin"`, `"npm"`);
    const { out, calls } = run(UPDATE_SCRIPT, update("probe", "", npm));
    expect(out).toMatchObject({ error: "InvalidRecord" });
    expect(calls).toEqual([]);
  });

  it("answers a PDS swap refusal as InvalidSwap", () => {
    const { out } = run(UPDATE_SCRIPT, update("probe", `, swapCid = "bafystale"`), {
      setup: `__put_error = "PDS_ERROR: InvalidSwap: Record was at bafyother"`,
    });
    expect(out).toMatchObject({ error: "InvalidSwap" });
  });

  it("answers any other write failure as Upstream, without the reason", () => {
    const { out } = run(UPDATE_SCRIPT, update("probe"), {
      setup: `__put_error = "PDS_ERROR: something about did:plc:pub's session"`,
    });
    expect(out).toMatchObject({ error: "Upstream" });
    expect(out.message).not.toContain("session");
  });

  it("needs a caller", () => {
    const { out, calls } = run(UPDATE_SCRIPT, update("probe"), { ctx: ANONYMOUS });
    expect(out).toMatchObject({ error: "AuthRequired" });
    expect(calls).toEqual([]);
  });
});

describe("withdrawRelease", () => {
  // A withdrawn release stays served by exact version and reads as withdrawn:
  // the indexer skips the delete and tombstones its state row. But the record
  // library drops a deleted record from the index the moment the PDS accepts
  // it, before the firehose brings the indexer the delete, so the procedure
  // puts the row straight back.
  it("deletes the caller's release record and keeps it indexed", () => {
    const { out, calls } = run(WITHDRAW_SCRIPT, `{ slug = "probe", version = "1.0.0" }`);
    expect(out).toEqual({ uri: "at://did:plc:pub/at.happyproto.plugin.release/probe:1.0.0" });
    expect(calls).toEqual([
      { fn: "delete", uri: "at://did:plc:pub/at.happyproto.plugin.release/probe:1.0.0" },
      {
        fn: "save_local",
        collection: "at.happyproto.plugin.release",
        rkey: "probe:1.0.0",
        body: { package: "probe", version: "1.0.0" },
      },
    ]);
  });

  it("refuses a version that is not published from the caller's account", () => {
    const { out, calls } = run(WITHDRAW_SCRIPT, `{ slug = "probe", version = "2.0.0" }`);
    expect(out).toMatchObject({ error: "ReleaseNotFound" });
    expect(calls).toEqual([]);
  });

  it("refuses a version already withdrawn, though it stays indexed", () => {
    const { out, calls } = run(WITHDRAW_SCRIPT, `{ slug = "probe", version = "1.0.0" }`, {
      setup: String.raw`__indexed["at://did:plc:hp/at.happyproto.registry.releaseState/did:plc:pub:probe:1.0.0"] = { status = "deleted" }`,
    });
    expect(out).toMatchObject({ error: "ReleaseNotFound" });
    expect(out.message).toContain("withdrawn");
    expect(calls).toEqual([]);
  });

  it("refuses a slug or version that could not name a release", () => {
    for (const input of [
      `{ slug = "probe", version = "v1" }`,
      `{ slug = "pro:be", version = "1.0.0" }`,
      `{ version = "1.0.0" }`,
    ]) {
      const { out, calls } = run(WITHDRAW_SCRIPT, input);
      expect(out).toMatchObject({ error: "InvalidRequest" });
      expect(calls).toEqual([]);
    }
  });

  it("answers a failed delete as Upstream", () => {
    const { out } = run(WITHDRAW_SCRIPT, `{ slug = "probe", version = "1.0.0" }`, {
      setup: `__delete_error = "PDS_ERROR: refused"`,
    });
    expect(out).toMatchObject({ error: "Upstream" });
  });

  it("needs a caller", () => {
    const { out, calls } = run(WITHDRAW_SCRIPT, `{ slug = "probe", version = "1.0.0" }`, {
      ctx: ANONYMOUS,
    });
    expect(out).toMatchObject({ error: "AuthRequired" });
    expect(calls).toEqual([]);
  });
});
