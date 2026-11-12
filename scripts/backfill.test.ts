/**
 * A project whose records arrive before its sidecar, end to end: the
 * sidecar's indexer queues registry.backfill-project, the job reads the
 * records from the publisher's PDS and stores those the indexers would have
 * taken, and the read API then answers them. Every script runs in one Lua
 * state against one index, as HappyView would run them in turn, with the
 * publisher's PDS faked through `__pds`.
 *
 * `happyview.record.save_local` is stubbed as the record plugin behaves with
 * `opts.cid` (happyproto/plugins#28): the CID is stored on insert, and an
 * update keeps the stored one.
 */
import { describe, expect } from "bun:test";
import { HARNESS } from "./harness";
import { findLua } from "./lua";
import { generated, it } from "./procedure";

const SCRIPTS = {
  sidecar: await generated("src/at/happyproto/registry/project.lua"),
  project: await generated("src/software/release/project.lua"),
  manifest: await generated("src/software/release/manifest.lua"),
  version: await generated("src/software/release/version.lua"),
  channel: await generated("src/software/release/channel.lua"),
  status: await generated("src/software/release/status.lua"),
  backfill: await generated("jobs/registry.backfill-project.lua"),
  getProject: await generated("src/at/happyproto/registry/getProject.lua"),
  getVersion: await generated("src/at/happyproto/registry/getVersion.lua"),
  listVersions: await generated("src/at/happyproto/registry/listVersions.lua"),
  resolveChannel: await generated("src/at/happyproto/registry/resolveChannel.lua"),
};

const DID = "did:plc:pub";
const HP = "did:plc:hp";
const PDS = "https://pds.test";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

const at = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
const PROJECT_URI = at(DID, "software.release.project", "probe");
const SIDECAR_URI = at(DID, "at.happyproto.registry.project", "probe");
const MANIFEST_URI = at(DID, "software.release.manifest", "3kmanifest");
const BAD_MANIFEST_URI = at(DID, "software.release.manifest", "3kbadmanifest");
const VERSION_URI = at(DID, "software.release.version", "probe.1.0.0");
const BAD_VERSION_URI = at(DID, "software.release.version", "probe.1.1.0");
const OTHER_VERSION_URI = at(DID, "software.release.version", "probe-two.1.0.0");
const CHANNEL_URI = at(DID, "software.release.channel", "probe.latest");
const STATUS_URI = at(DID, "software.release.status", "3kstatus");
const STATE_URI = at(HP, "at.happyproto.registry.versionState", `${DID}:probe:1.0.0`);

const listUrl = (collection: string) =>
  `${PDS}/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Apub&collection=${collection}&limit=100`;
const getUrl = (collection: string, rkey: string) =>
  `${PDS}/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Apub&collection=${collection}&rkey=${rkey}`;

const blob = (mimeType: string, size: number) =>
  `{ ["$type"] = "blob", ref = { ["$link"] = "${CID}" }, mimeType = "${mimeType}", size = ${size} }`;

const artifact = (pluginType = "interpreter") => `{
  ["$type"] = "at.happyproto.plugin.v1",
  package = ${blob("application/wasm", 1234)},
  manifest = ${blob("application/json", 456)},
  pluginType = "${pluginType}",
  apiVersion = "2",
  capabilities = { "library:call" },
  languageId = "lua",
  fileExtensions = { "lua" },
  namespace = "probe",
  license = "MIT",
  sections = { description = "Runs Lua." },
}`;

const SIDECAR = `{
  ["$type"] = "at.happyproto.registry.project",
  project = "${PROJECT_URI}",
  publication = { uri = "${at(DID, "site.standard.publication", "probe")}", cid = "bafypub" },
  pluginType = "interpreter",
  authors = { { name = "Trezy" } },
  security = { { email = "security@example.com" } },
}`;

/**
 * What the publisher's repo holds for probe, as its PDS lists it, each with
 * the CID the PDS answers: the project; a valid manifest and one of another
 * plugin type; version 1.0.0 on the valid manifest, 1.1.0 pinning it by a
 * CID it does not have, and a version of another project whose key only
 * starts with probe; the latest channel; and a status about 1.0.0.
 */
const RECORDS = {
  project: `{ ["$type"] = "software.release.project", name = "probe" }`,
  manifest: `{ ["$type"] = "software.release.manifest", project = "${PROJECT_URI}", artifacts = { ${artifact()} } }`,
  badManifest: `{ ["$type"] = "software.release.manifest", project = "${PROJECT_URI}", artifacts = { ${artifact("library")} } }`,
  version: `{ ["$type"] = "software.release.version", project = "${PROJECT_URI}", version = "1.0.0",
    manifest = { uri = "${MANIFEST_URI}", cid = "bafymanifestpds" }, changelog = "${at(DID, "site.standard.document", "3kdoc")}" }`,
  badVersion: `{ ["$type"] = "software.release.version", project = "${PROJECT_URI}", version = "1.1.0",
    manifest = { uri = "${MANIFEST_URI}", cid = "bafynotthemanifest" } }`,
  otherVersion: `{ ["$type"] = "software.release.version", project = "${at(DID, "software.release.project", "probe-two")}", version = "1.0.0",
    manifest = { uri = "${MANIFEST_URI}", cid = "bafymanifestpds" } }`,
  channel: `{ ["$type"] = "software.release.channel", project = "${PROJECT_URI}", channel = "latest",
    version = { uri = "${VERSION_URI}", cid = "bafyversionpds" } }`,
  status: `{ ["$type"] = "software.release.status", subject = "${VERSION_URI}", status = "endOfSupport", reason = "Use 2.0.0." }`,
};

const STUBS = String.raw`
__indexed = {}
__order = 0
function __store(uri, cid, record, indexed_at)
  __order = __order + 1
  local did, collection, rkey = uri:match("^at://([^/]+)/([^/]+)/(.+)$")
  __indexed[uri] = { uri = uri, did = did, collection = collection, rkey = rkey, cid = cid,
    record = record, indexed_at = indexed_at, order = __order }
end

-- The publisher's PDS: a listing per collection and the project by key.
__pds = {}
local function listing(collection, entries)
  local key = "LIST " .. collection
  __pds["${PDS}/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Apub&collection=" .. collection .. "&limit=100"] =
    { status = 200, body = key }
  __decoded[key] = { records = entries }
end
local function entry(uri, cid, value) return { uri = uri, cid = cid, value = value } end
listing("software.release.manifest", {
  entry("${MANIFEST_URI}", "bafymanifestpds", ${RECORDS.manifest}),
  entry("${BAD_MANIFEST_URI}", "bafybadmanifestpds", ${RECORDS.badManifest}),
  entry("${at(DID, "software.release.manifest", "3kelse")}", "bafyelse", { project = "${at(DID, "software.release.project", "probe-two")}" }),
})
listing("software.release.version", {
  entry("${BAD_VERSION_URI}", "bafybadversionpds", ${RECORDS.badVersion}),
  entry("${VERSION_URI}", "bafyversionpds", ${RECORDS.version}),
  entry("${OTHER_VERSION_URI}", "bafyotherversionpds", ${RECORDS.otherVersion}),
})
listing("software.release.channel", { entry("${CHANNEL_URI}", "bafychannelpds", ${RECORDS.channel}) })
listing("software.release.status", { entry("${STATUS_URI}", "bafystatuspds", ${RECORDS.status}) })
__pds["${getUrl("software.release.project", "probe")}"] = { status = 200, body = "PROJECT" }
__decoded["PROJECT"] = { uri = "${PROJECT_URI}", cid = "bafyprojectpds", value = ${RECORDS.project} }

__reply = function(method, url) return __pds[url] or { status = 404, body = "" } end

package.preload["happyview.atproto"] = function()
  return {
    resolve_service_endpoint = function(did)
      __calls[#__calls + 1] = { fn = "resolve", did = did }
      if did == "${DID}" then return "${PDS}" end
      return nil
    end,
    resolve_identity = function(actor)
      if actor == "${DID}" then return { did = "${DID}", handle = "pub.test" } end
      error("could not resolve " .. tostring(actor))
    end,
  }
end

-- happyview.record as the record plugin behaves with opts.cid: the CID is
-- stored on insert only, and the row has no indexed_at until the network
-- echoes it.
package.preload["happyview.record"] = function()
  return {
    save_local = function(collection, rkey, body, did, opts)
      local cid = opts and opts.cid
      __calls[#__calls + 1] = { fn = "save_local", collection = collection, rkey = rkey, did = did, cid = cid }
      local uri = "at://" .. did .. "/" .. collection .. "/" .. rkey
      local row = __indexed[uri]
      if row then row.record = body else __store(uri, (not __no_cid_option) and cid or "", body, nil) end
      return { uri = uri, cid = __indexed[uri].cid }
    end,
    delete_local = function(uri)
      __calls[#__calls + 1] = { fn = "delete_local", uri = uri }
      local had = __indexed[uri] ~= nil
      __indexed[uri] = nil
      return had
    end,
  }
end

local function field(record, path)
  local v = record
  for part in path:gmatch("[^.]+") do
    if type(v) ~= "table" then return nil end
    v = v[part]
  end
  return v
end

package.preload["happyview.db"] = function()
  return {
    get = function(uri) return __indexed[uri] end,
    records = function(collection)
      local q = { filters = {} }
      function q:did(d) self.owner = d; return self end
      function q:where(path, op, value) self.filters[#self.filters + 1] = { path, op, value }; return self end
      function q:sort(f, direction) self.descending = direction == "desc"; return self end
      function q:limit(n) self.max = n; return self end
      function q:cursor() return self end
      function q:run()
        local rows = {}
        for _, e in pairs(__indexed) do
          local keep = e.collection == collection and (self.owner == nil or e.did == self.owner)
          for _, f in ipairs(self.filters) do
            if f[2] ~= "=" or field(e.record, f[1]) ~= f[3] then keep = false end
          end
          if keep then rows[#rows + 1] = e end
        end
        table.sort(rows, function(a, b)
          if self.descending then return a.order > b.order end
          return a.order < b.order
        end)
        local out = {}
        for i = 1, math.min(#rows, self.max or 100) do out[i] = rows[i] end
        return { records = out }
      end
      return q
    end,
  }
end

package.preload["happyview.blobs"] = function()
  return { stat = function() return nil end }
end
`;

const lua = findLua();

/**
 * Runs `steps` after every script has been loaded, each as `__scripts.<name>`.
 * Each script is loaded in a block of its own, so the prelude each carries is
 * scoped to it, as in its own VM.
 */
function run(steps: string, setup = ""): { out: any; calls: any[]; indexed: Record<string, any> } {
  if (!lua) throw new Error("no lua on PATH, so the scripts were never executed");
  const loaded = Object.entries(SCRIPTS)
    .map(([name, source]) => `do\n${source}\n__scripts["${name}"] = handle\nend`)
    .join("\n\n");
  const source = [
    HARNESS,
    STUBS,
    setup,
    "__scripts = {}",
    loaded,
    `__ctx = { env = { HAPPYPROTO_DID = "${HP}" } }`,
    "__out = {}",
    steps,
    "io.write(__encode({ out = __out, calls = __calls, indexed = __indexed }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return { out: parsed.out ?? {}, calls: Array.isArray(parsed.calls) ? parsed.calls : [], indexed: parsed.indexed ?? {} };
}

/** An index event for `script`, stored as HappyView stores what it returns true for. */
const event = (script: string, uri: string, record: string, cid: string, action = "create") => {
  const [, did, collection, rkey] = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/)!;
  return `
do
  local r = ${record}
  local stored = __scripts.${script}({ action = "${action}", uri = "${uri}", did = "${did}", collection = "${collection}", rkey = "${rkey}", record = r }, __ctx)
  __out.indexed = __out.indexed or {}
  __out.indexed["${uri}"] = stored == true
  if stored then __store("${uri}", "${cid}", r, "2026-11-12T00:00:00Z") end
end`;
};

/** Runs every backfill job queued so far, once. */
const RUN_BACKFILLS = `
__out.backfills = {}
local queued = {}
for _, c in ipairs(__calls) do
  if c.fn == "create" and c.job_type == "registry.backfill-project" then queued[#queued + 1] = c.input end
end
for _, input in ipairs(queued) do
  local ok, result = pcall(__scripts.backfill, input, __ctx)
  __out.backfills[#__out.backfills + 1] = ok and result or { error = tostring(result) }
end`;

/** Every read, as an installing HappyView would make them. */
const READ = `
__out.getProject = __scripts.getProject({ actor = "${DID}", name = "probe" }, __ctx)
__out.getVersion = __scripts.getVersion({ did = "${DID}", name = "probe", version = "1.0.0" }, __ctx)
__out.listVersions = __scripts.listVersions({ did = "${DID}", name = "probe" }, __ctx)
__out.resolveChannel = __scripts.resolveChannel({ did = "${DID}", name = "probe", channel = "latest" }, __ctx)`;

const jobsOf = (calls: any[], type: string) => calls.filter((c) => c.fn === "create" && c.job_type === type);

describe("records first, then the sidecar", () => {
  // Every record the network delivers before the sidecar is skipped by its
  // indexer; then the sidecar arrives, and its backfill runs.
  const BEFORE = [
    event("project", PROJECT_URI, RECORDS.project, "bafyprojectpds"),
    event("manifest", MANIFEST_URI, RECORDS.manifest, "bafymanifestpds"),
    event("version", VERSION_URI, RECORDS.version, "bafyversionpds"),
    event("channel", CHANNEL_URI, RECORDS.channel, "bafychannelpds"),
    event("status", STATUS_URI, RECORDS.status, "bafystatuspds"),
  ].join("\n");
  const FLOW = BEFORE + "\n" + event("sidecar", SIDECAR_URI, SIDECAR, "bafysidecar") + "\n" + RUN_BACKFILLS + "\n" + READ;

  it("says so when a collection runs past its listing cap", () => {
    // A statuses listing that never ends: every page holds one record of
    // another project and points at another page.
    const ENDLESS = `
do
  local base = "${PDS}/xrpc/com.atproto.repo.listRecords?repo=did%3Aplc%3Apub&collection=software.release.status&limit=100"
  __pds[base] = { status = 200, body = "LIST endless" }
  __pds[base .. "&cursor=more"] = { status = 200, body = "LIST endless" }
  __decoded["LIST endless"] = {
    cursor = "more",
    records = { { uri = "${at(DID, "software.release.status", "3kother")}", cid = "bafyother",
      value = { subject = "${at(DID, "software.release.project", "probe-two")}", status = "deprecated" } } },
  }
end`;
    const { out } = run(ENDLESS + "\n" + FLOW + "\n__out.log = __log");
    expect(out.backfills[0].truncated).toBe(true);
    const warned = (out.log as any[]).filter((l) => l.level === "warn" && /listing cap/.test(l.message));
    expect(warned.length).toBe(1);
    expect(warned[0].fields.max_records).toBe(2000);
    // What was within reach is still stored.
    expect(out.backfills[0].stored.length).toBeGreaterThan(0);
  });

  it("skips every record while there is no sidecar", () => {
    const { out } = run(BEFORE);
    expect(Object.values(out.indexed)).toEqual([false, false, false, false, false]);
  });

  it("queues the backfill when the sidecar arrives, and the job stores each record with the PDS's CID", () => {
    const { out, calls, indexed } = run(FLOW);
    expect(out.indexed[SIDECAR_URI]).toBe(true);
    expect(out.backfills).toHaveLength(1);
    expect(out.backfills[0].error).toBeUndefined();
    expect(out.backfills[0].stored).toEqual([PROJECT_URI, MANIFEST_URI, VERSION_URI, CHANNEL_URI, STATUS_URI]);
    // In the order the indexers need, each with the CID its PDS answered.
    expect(calls.filter((c) => c.fn === "save_local" && c.did === DID).map((c) => [c.collection, c.cid])).toEqual([
      ["software.release.project", "bafyprojectpds"],
      ["software.release.manifest", "bafymanifestpds"],
      ["software.release.version", "bafyversionpds"],
      ["software.release.channel", "bafychannelpds"],
      ["software.release.status", "bafystatuspds"],
    ]);
    for (const [uri, cid] of [
      [PROJECT_URI, "bafyprojectpds"], [MANIFEST_URI, "bafymanifestpds"], [VERSION_URI, "bafyversionpds"],
      [CHANNEL_URI, "bafychannelpds"], [STATUS_URI, "bafystatuspds"],
    ]) {
      expect(indexed[uri].cid).toBe(cid);
    }
  });

  it("writes the state the version indexer would, and queues its copy and changelog fetch", () => {
    const { calls, indexed } = run(FLOW);
    expect(indexed[STATE_URI].record).toEqual({
      did: DID,
      name: "probe",
      version: "1.0.0",
      uri: VERSION_URI,
      manifestUri: MANIFEST_URI,
      manifestCid: "bafymanifestpds",
      availability: "pending",
      suspect: false,
    });
    expect(jobsOf(calls, "registry.copy-version").map((c) => c.input)).toEqual([{ did: DID, name: "probe", version: "1.0.0" }]);
    expect(jobsOf(calls, "registry.fetch-changelog").map((c) => c.input.uri)).toEqual([at(DID, "site.standard.document", "3kdoc")]);
  });

  it("then answers getProject, getVersion, listVersions and resolveChannel, the strongRefs verifying", () => {
    const { out } = run(FLOW);
    expect(out.getProject.error).toBeUndefined();
    expect(out.getProject.cid).toBe("bafyprojectpds");
    expect(out.getProject.channels.latest).toMatchObject({ version: "1.0.0", cid: "bafyversionpds", state: "deprecated" });
    expect(out.getVersion.error).toBeUndefined();
    expect(out.getVersion).toMatchObject({
      version: "1.0.0", cid: "bafyversionpds", manifest: { uri: MANIFEST_URI, cid: "bafymanifestpds" }, availability: "pending",
    });
    expect(out.getVersion.lifecycle.reason).toBe("Use 2.0.0.");
    expect(out.listVersions.versions.map((v: any) => v.version)).toEqual(["1.0.0"]);
    expect(out.resolveChannel.version).toBe("1.0.0");
  });

  it("stores no record that fails its indexer's check, nor one of another project", () => {
    const { out, indexed } = run(FLOW);
    expect(indexed[BAD_MANIFEST_URI]).toBeUndefined();
    expect(indexed[BAD_VERSION_URI]).toBeUndefined();
    expect(indexed[OTHER_VERSION_URI]).toBeUndefined();
    expect(indexed[at(DID, "software.release.manifest", "3kelse")]).toBeUndefined();
    expect(out.backfills[0].refused.map((r: any) => r.uri).sort()).toEqual([BAD_MANIFEST_URI, BAD_VERSION_URI].sort());
    expect(out.backfills[0].refused.find((r: any) => r.uri === BAD_MANIFEST_URI).reason).toBe(
      "pluginType is not the one the sidecar declares",
    );
    expect(out.backfills[0].refused.find((r: any) => r.uri === BAD_VERSION_URI).reason).toBe(
      "the version's manifest is not a stored manifest of its project",
    );
  });

  it("leaves records already in the index as they are, so running again stores nothing", () => {
    const { out, calls } = run(FLOW + "\n" + RUN_BACKFILLS.replace("__out.backfills = {}", "__out.first = __out.backfills; __out.backfills = {}"));
    expect(out.backfills[0].stored).toEqual({});
    expect(calls.filter((c) => c.fn === "save_local" && c.did === DID)).toHaveLength(5);
    expect(jobsOf(calls, "registry.copy-version")).toHaveLength(1);
  });

  it("raises, to be retried, when the publisher's PDS cannot be reached", () => {
    const down = run(
      event("sidecar", SIDECAR_URI, SIDECAR, "bafysidecar") + "\n" + `__reply = function() return { status = 503, body = "" } end` + "\n" + RUN_BACKFILLS,
    );
    expect(down.out.backfills[0].error).toContain("could not");
  });

  it("stores nothing and fails loudly on a record plugin that drops opts.cid", () => {
    // The plugin release this needs (happyproto/plugins#28) is not yet the
    // one installed: a row stored without its CID is taken back out.
    const { out, calls, indexed } = run(BEFORE + "\n" + event("sidecar", SIDECAR_URI, SIDECAR, "bafysidecar") + "\n" + RUN_BACKFILLS, "__no_cid_option = true");
    expect(out.backfills[0].error).toContain("must support save_local's opts.cid");
    expect(indexed[PROJECT_URI]).toBeUndefined();
    expect(calls.filter((c) => c.fn === "delete_local").map((c) => c.uri)).toEqual([PROJECT_URI]);
    expect(jobsOf(calls, "registry.copy-version")).toEqual([]);
  });

  it("does nothing, and does not retry, when the publisher's repo has no project yet", () => {
    const { out } = run(
      event("sidecar", SIDECAR_URI, SIDECAR, "bafysidecar") +
        `\n__pds["${getUrl("software.release.project", "probe")}"] = { status = 400, body = "" }\n` + RUN_BACKFILLS,
    );
    expect(out.backfills[0]).toEqual({ skipped: "the publisher's repo has no project probe yet" });
  });

  it("raises, to be retried, when it runs before HappyView stored the sidecar", () => {
    const { out } = run(`__out.result = { pcall(__scripts.backfill, { did = "${DID}", name = "probe" }, __ctx) }`);
    expect(out.result[0]).toBe(false);
    expect(out.result[1]).toContain("is not stored yet");
  });

  it("does nothing for a sidecar deleted again before it ran", () => {
    const { out, calls } = run(
      `__store("${SIDECAR_URI}", "bafysidecar", ${SIDECAR})
__store("${at(HP, "at.happyproto.registry.projectState", `${DID}:probe`)}", nil, { did = "${DID}", name = "probe", sidecarDeleted = true })
__out.result = __scripts.backfill({ did = "${DID}", name = "probe" }, __ctx)`,
    );
    expect(out.result).toEqual({ skipped: "the sidecar was deleted" });
    expect(calls.filter((c) => c.fn === "save_local" || c.fn === "get")).toEqual([]);
  });
});

describe("the sidecar first, then the records", () => {
  it("indexes each record as it arrives, as today, and the backfill finds nothing more to store", () => {
    const steps = [
      event("sidecar", SIDECAR_URI, SIDECAR, "bafysidecar"),
      event("project", PROJECT_URI, RECORDS.project, "bafyprojectpds"),
      event("manifest", MANIFEST_URI, RECORDS.manifest, "bafymanifestpds"),
      event("version", VERSION_URI, RECORDS.version, "bafyversionpds"),
      event("channel", CHANNEL_URI, RECORDS.channel, "bafychannelpds"),
      event("status", STATUS_URI, RECORDS.status, "bafystatuspds"),
      RUN_BACKFILLS,
      READ,
    ].join("\n");
    const { out, calls } = run(steps);
    expect(out.indexed).toEqual({
      [SIDECAR_URI]: true, [PROJECT_URI]: true, [MANIFEST_URI]: true, [VERSION_URI]: true, [CHANNEL_URI]: true, [STATUS_URI]: true,
    });
    // The job queued with the sidecar ran after the records were indexed.
    expect(out.backfills[0].stored).toEqual({});
    expect(jobsOf(calls, "registry.copy-version")).toHaveLength(1);
    expect(out.getVersion.version).toBe("1.0.0");
    expect(out.resolveChannel.version).toBe("1.0.0");
  });
});

describe("what never backfills", () => {
  it("a replayed sidecar queues no job", () => {
    const { calls } = run(
      `__store("${SIDECAR_URI}", "bafysidecar", ${SIDECAR}, "2026-11-12T00:00:00Z")\n` + event("sidecar", SIDECAR_URI, SIDECAR, "bafysidecar"),
    );
    expect(jobsOf(calls, "registry.backfill-project")).toEqual([]);
  });

  it("the reserved name happyview: its sidecar is refused, and the job stores nothing even when asked", () => {
    const hv = SIDECAR.replaceAll("/probe", "/happyview");
    const { out, calls } = run(
      event("sidecar", at(DID, "at.happyproto.registry.project", "happyview"), hv, "bafyhv") +
        `\n__out.direct = __scripts.backfill({ did = "${DID}", name = "happyview" }, __ctx)`,
    );
    expect(Object.values(out.indexed)).toEqual([false]);
    expect(jobsOf(calls, "registry.backfill-project")).toEqual([]);
    expect(out.direct).toEqual({ skipped: "the name happyview is reserved for HappyView's own releases" });
    expect(calls.filter((c) => c.fn === "save_local" || c.fn === "get" || c.fn === "resolve")).toEqual([]);
  });
});
