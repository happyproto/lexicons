/**
 * registry.retryRelease, executed. A release is listed only once the copy job
 * the indexer enqueues has copied its artifact, and nothing else ever enqueues
 * that job again: one that fails leaves the release pending for good. This is
 * how its publisher tries again.
 */
import { describe, expect } from "bun:test";
import { generated, it, run as runProcedure } from "./procedure";

const SCRIPT = await generated("src/at/happyproto/registry/retryRelease.lua");

const RELEASE = "at://did:plc:pub/at.happyproto.plugin.release/probe:1.0.0";
const STATE = "at://did:plc:hp/at.happyproto.registry.releaseState/did:plc:pub:probe:1.0.0";

/**
 * An index holding the publisher's release 1.0.0 and its state row, pending
 * unless a test says otherwise, and a jobs library that remembers each job it
 * is asked to create. `__create_error`, when set, is raised by create the way
 * the host raises a database failure.
 */
const STUBS = String.raw`
__indexed = {
  ["${RELEASE}"] = { package = "probe", version = "1.0.0" },
  ["${STATE}"] = { status = "pending" },
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
package.preload["happyview.jobs"] = function()
  return {
    create = function(job_type, input)
      __calls[#__calls + 1] = { fn = "create", job_type = job_type, input = input }
      if __create_error then error(__create_error) end
      return "job-1"
    end,
  }
end
package.preload["happyview.record"] = function() return {} end
package.preload["happyview.atproto"] = function() return {} end
`;

const CTX = `{ caller_did = "did:plc:pub", env = { HAPPYPROTO_DID = "did:plc:hp" } }`;
const ANONYMOUS = `{ env = { HAPPYPROTO_DID = "did:plc:hp" } }`;
const INPUT = `{ slug = "probe", version = "1.0.0" }`;

function run(input: string, { ctx = CTX, setup = "" } = {}) {
  return runProcedure(SCRIPT, STUBS + setup, input, ctx);
}

describe("retryRelease", () => {
  it("enqueues the copy again for a pending release, as the indexer did", () => {
    const { out, calls } = run(INPUT);
    expect(out).toEqual({ uri: RELEASE, status: "pending" });
    expect(calls).toEqual([
      {
        fn: "create",
        job_type: "registry.copy-artifact",
        input: {
          did: "did:plc:pub",
          slug: "probe",
          version: "1.0.0",
          uri: RELEASE,
          stateRkey: "did:plc:pub:probe:1.0.0",
        },
      },
    ]);
  });

  it("leaves an active release alone", () => {
    const { out, calls } = run(INPUT, {
      setup: String.raw`__indexed["${STATE}"] = { status = "active" }`,
    });
    expect(out).toEqual({ uri: RELEASE, status: "active" });
    expect(calls).toEqual([]);
  });

  it("refuses a withdrawn release", () => {
    const { out, calls } = run(INPUT, {
      setup: String.raw`__indexed["${STATE}"] = { status = "deleted" }`,
    });
    expect(out).toMatchObject({ error: "ReleaseNotFound" });
    expect(out.message).toContain("withdrawn");
    expect(calls).toEqual([]);
  });

  it("refuses a version that is not published from the caller's account", () => {
    const { out, calls } = run(`{ slug = "probe", version = "2.0.0" }`);
    expect(out).toMatchObject({ error: "ReleaseNotFound" });
    expect(calls).toEqual([]);
  });

  it("refuses a release the registry never indexed, which a retry cannot fix", () => {
    const { out, calls } = run(INPUT, { setup: String.raw`__indexed["${STATE}"] = nil` });
    expect(out).toMatchObject({ error: "ReleaseNotIndexed" });
    expect(calls).toEqual([]);
  });

  it("refuses a slug or version that could not name a release", () => {
    for (const input of [
      `{ slug = "probe", version = "v1" }`,
      `{ slug = "pro:be", version = "1.0.0" }`,
      `{ version = "1.0.0" }`,
    ]) {
      const { out, calls } = run(input);
      expect(out).toMatchObject({ error: "InvalidRequest" });
      expect(calls).toEqual([]);
    }
  });

  it("answers a job that could not be created as Upstream", () => {
    const { out } = run(INPUT, { setup: `__create_error = "HOST_ERROR: database"` });
    expect(out).toMatchObject({ error: "Upstream" });
  });

  it("needs a caller", () => {
    const { out, calls } = run(INPUT, { ctx: ANONYMOUS });
    expect(out).toMatchObject({ error: "AuthRequired" });
    expect(calls).toEqual([]);
  });
});
