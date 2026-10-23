/**
 * The record.index scripts for software.release.* and the
 * at.happyproto.registry.project sidecar, executed against an index held in a
 * Lua table. Each case feeds one Jetstream event and reads back what the
 * script answered (true stores the record, nil skips it) and what it asked
 * HappyView to do: local state writes, jobs and log lines.
 */
import { describe, expect } from "bun:test";
import { generated, it, run as runScript } from "./procedure";

const SIDECAR_SCRIPT = await generated("src/at/happyproto/registry/project.lua");
const PROJECT_SCRIPT = await generated("src/software/release/project.lua");
const MANIFEST_SCRIPT = await generated("src/software/release/manifest.lua");
const VERSION_SCRIPT = await generated("src/software/release/version.lua");
const CHANNEL_SCRIPT = await generated("src/software/release/channel.lua");
const STATUS_SCRIPT = await generated("src/software/release/status.lua");

const DID = "did:plc:pub";
const EVE = "did:plc:eve";
const HP = "did:plc:hp";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

const at = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
const PROJECT_URI = at(DID, "software.release.project", "probe");
const OTHER_PROJECT_URI = at(DID, "software.release.project", "other");
const SIDECAR_URI = at(DID, "at.happyproto.registry.project", "probe");
const MANIFEST_URI = at(DID, "software.release.manifest", "3kmanifest");
const OTHER_MANIFEST_URI = at(DID, "software.release.manifest", "3kother");
const EVE_MANIFEST_URI = at(EVE, "software.release.manifest", "3keve");
const VERSION_URI = at(DID, "software.release.version", "probe:1.0.0");
const OTHER_VERSION_URI = at(DID, "software.release.version", "other:1.0.0");
const EVE_VERSION_URI = at(EVE, "software.release.version", "probe:1.0.0");
const STATUS_URI = at(DID, "software.release.status", "3kstatus");
const STATE_URI = (rkey: string) => at(HP, "at.happyproto.registry.versionState", rkey);

const blob = (mimeType: string, size: number) =>
  `{ ["$type"] = "blob", ref = { ["$link"] = "${CID}" }, mimeType = "${mimeType}", size = ${size} }`;

const ARTIFACT = `{
  ["$type"] = "at.happyproto.plugin.v1",
  package = ${blob("application/wasm", 1234)},
  manifest = ${blob("application/json", 456)},
  pluginType = "interpreter",
  apiVersion = "2",
  capabilities = { "library:call" },
  languageId = "lua",
  fileExtensions = { "lua" },
  license = "MIT",
  sections = { description = "Runs Lua." },
}`;

const manifest = (project = PROJECT_URI, artifact = ARTIFACT) =>
  `{ ["$type"] = "software.release.manifest", project = "${project}", artifacts = { ${artifact} } }`;

const sidecar = (did: string, name: string, pluginType = "interpreter") => `{
  ["$type"] = "at.happyproto.registry.project",
  project = "${at(did, "software.release.project", name)}",
  publication = { uri = "${at(did, "site.standard.publication", name)}", cid = "bafypub" },
  pluginType = "${pluginType}",
  authors = { { name = "Trezy" } },
  security = { { email = "security@example.com" } },
}`;

const versionRecord = ({
  version = "1.0.0",
  project = PROJECT_URI,
  manifestUri = MANIFEST_URI,
  manifestCid = "bafymanifest",
  extra = "",
} = {}) => `{
  ["$type"] = "software.release.version",
  project = "${project}",
  version = "${version}",
  manifest = { uri = "${manifestUri}", cid = "${manifestCid}" },
  ${extra}
}`;

/**
 * The index before each event: a publisher `did:plc:pub` with two plugin
 * projects, `probe` and `other`, each with a sidecar and a manifest, and
 * `probe` at 1.0.0; `did:plc:eve` with her own `probe`; and the registry's
 * state for probe 1.0.0 and other 1.0.0. `__indexed` maps a uri to its
 * envelope, as `db.get` answers it.
 */
const STUBS = String.raw`
__calls = {}
__indexed = {}
local function put(uri, cid, record) __indexed[uri] = { uri = uri, cid = cid, record = record } end

put("${SIDECAR_URI}", "bafysidecar", ${sidecar(DID, "probe")})
put("${at(DID, "at.happyproto.registry.project", "other")}", "bafysidecar2", ${sidecar(DID, "other")})
put("${at(EVE, "at.happyproto.registry.project", "probe")}", "bafyevesidecar", ${sidecar(EVE, "probe")})
put("${PROJECT_URI}", "bafyproject", { ["$type"] = "software.release.project", name = "probe" })
put("${OTHER_PROJECT_URI}", "bafyproject2", { ["$type"] = "software.release.project", name = "other" })
put("${at(EVE, "software.release.project", "probe")}", "bafyeveproject", { ["$type"] = "software.release.project", name = "probe" })
put("${MANIFEST_URI}", "bafymanifest", ${manifest()})
put("${OTHER_MANIFEST_URI}", "bafyother", ${manifest(OTHER_PROJECT_URI)})
put("${EVE_MANIFEST_URI}", "bafyeve", ${manifest(at(EVE, "software.release.project", "probe"))})
put("${VERSION_URI}", "bafyversion", ${versionRecord()})
put("${OTHER_VERSION_URI}", "bafyversion2", ${versionRecord({ project: OTHER_PROJECT_URI, manifestUri: OTHER_MANIFEST_URI, manifestCid: "bafyother" })})
put("${EVE_VERSION_URI}", "bafyeveversion", ${versionRecord({ project: at(EVE, "software.release.project", "probe"), manifestUri: EVE_MANIFEST_URI, manifestCid: "bafyeve" })})
put("${STATUS_URI}", "bafystatus", { subject = "${VERSION_URI}", status = "endOfSupport" })
put("${at(EVE, "software.release.status", "3keve")}", "bafyevestatus", { subject = "${EVE_VERSION_URI}", status = "endOfSupport" })
put("${STATE_URI(`${DID}:probe:1.0.0`)}", nil, {
  did = "${DID}", name = "probe", version = "1.0.0", uri = "${VERSION_URI}",
  manifestUri = "${MANIFEST_URI}", manifestCid = "bafymanifest",
  availability = "available", suspect = false,
})
put("${STATE_URI(`${DID}:other:1.0.0`)}", nil, {
  did = "${DID}", name = "other", version = "1.0.0", uri = "${OTHER_VERSION_URI}",
  manifestUri = "${OTHER_MANIFEST_URI}", manifestCid = "bafyother",
  availability = "available", suspect = false,
})

package.preload["happyview.db"] = function()
  local function parts(uri) return uri:match("^at://([^/]+)/([^/]+)/(.+)$") end
  return {
    get = function(uri) return __indexed[uri] end,
    records = function(collection)
      local q = { filters = {} }
      function q:did(d) self.owner = d; return self end
      function q:where(path, op, value) self.filters[#self.filters + 1] = { path, op, value }; return self end
      function q:sort() return self end
      function q:limit() return self end
      function q:cursor() return self end
      function q:run()
        local uris = {}
        for uri in pairs(__indexed) do uris[#uris + 1] = uri end
        table.sort(uris)
        local out = {}
        for _, uri in ipairs(uris) do
          local did, c = parts(uri)
          local e = __indexed[uri]
          local keep = c == collection and (self.owner == nil or did == self.owner)
          for _, f in ipairs(self.filters) do
            if f[2] ~= "=" or e.record[f[1]] ~= f[3] then keep = false end
          end
          if keep then out[#out + 1] = e end
        end
        return { records = out }
      end
      return q
    end,
  }
end

package.preload["happyview.record"] = function()
  return {
    save_local = function(collection, rkey, body, did)
      __calls[#__calls + 1] = { fn = "save_local", collection = collection, rkey = rkey, body = body, did = did }
      local uri = "at://" .. did .. "/" .. collection .. "/" .. rkey
      __indexed[uri] = { uri = uri, record = body }
      return { uri = uri }
    end,
  }
end

package.preload["internal.logging"] = function()
  local function at(level)
    return function(message, fields)
      __calls[#__calls + 1] = { fn = "log", level = level, message = message }
    end
  end
  return { debug = at("debug"), info = at("info"), warn = at("warn"), error = at("error") }
end
`;

const CTX = `{ env = { HAPPYPROTO_DID = "${HP}" } }`;

type Event = { action?: string; did?: string; collection: string; rkey: string; record?: string };

function index(script: string, e: Event, { setup = "", ctx = CTX } = {}) {
  const did = e.did ?? DID;
  const input = `{
    action = "${e.action ?? "create"}",
    uri = "${at(did, e.collection, e.rkey)}",
    did = "${did}",
    collection = "${e.collection}",
    rkey = "${e.rkey}",
    record = ${e.record ?? "nil"},
  }`;
  const { out, calls } = runScript(script, STUBS + setup, input, ctx);
  return { out: out ?? null, calls };
}

const writes = (calls: any[]) => calls.filter((c) => c.fn === "save_local");
const jobs = (calls: any[]) => calls.filter((c) => c.fn === "create");
const logs = (calls: any[]) => calls.filter((c) => c.fn === "log");
const noSidecar = (did: string, name: string) =>
  `__indexed["${at(did, "at.happyproto.registry.project", name)}"] = nil`;
const unindex = (uri: string) => `__indexed["${uri}"] = nil`;

describe("every index script", () => {
  const scripts: [string, string, Event, string?][] = [
    ["sidecar", SIDECAR_SCRIPT, { collection: "at.happyproto.registry.project", rkey: "probe", record: sidecar(DID, "probe") }],
    ["project", PROJECT_SCRIPT, { collection: "software.release.project", rkey: "probe", record: `{ name = "probe" }` }, unindex(PROJECT_URI)],
    ["manifest", MANIFEST_SCRIPT, { collection: "software.release.manifest", rkey: "3knew", record: manifest() }],
    ["version", VERSION_SCRIPT, { collection: "software.release.version", rkey: "probe:1.1.0", record: versionRecord({ version: "1.1.0" }) }],
    ["channel", CHANNEL_SCRIPT, { collection: "software.release.channel", rkey: "probe:latest", record: `{ project = "${PROJECT_URI}", name = "latest", version = { uri = "${VERSION_URI}", cid = "bafyversion" } }` }],
    ["status", STATUS_SCRIPT, { collection: "software.release.status", rkey: "3knew", record: `{ subject = "${VERSION_URI}", status = "endOfLife" }` }],
  ];
  for (const [name, script, event, setup = ""] of scripts) {
    it(`${name}: raises without HAPPYPROTO_DID, so the event retries instead of being lost`, () => {
      expect(() => index(script, event, { ctx: `{ env = {} }` })).toThrow(/HAPPYPROTO_DID/);
    });
    it(`${name}: stores the well-formed record of a project with a sidecar`, () => {
      expect(index(script, event, { setup }).out).toBe(true);
    });
    it(`${name}: keeps the row on delete`, () => {
      expect(index(script, { ...event, action: "delete", record: undefined }).out).toBeNull();
    });
  }
});

describe("the sidecar (at.happyproto.registry.project)", () => {
  const event = { collection: "at.happyproto.registry.project", rkey: "probe", record: sidecar(DID, "probe") };

  it("stores it and fetches its pinned publication", () => {
    const { out, calls } = index(SIDECAR_SCRIPT, event);
    expect(out).toBe(true);
    expect(jobs(calls)).toEqual([
      {
        fn: "create",
        job_type: "registry.fetch-publication",
        input: { did: DID, name: "probe", uri: at(DID, "site.standard.publication", "probe"), cid: "bafypub" },
      },
    ]);
  });

  it("stores it before its project exists, since the gateway writes it first", () => {
    const { out } = index(SIDECAR_SCRIPT, event, { setup: unindex(PROJECT_URI) });
    expect(out).toBe(true);
  });

  it("refetches the publication on an update, the event that says it moved", () => {
    const { out, calls } = index(SIDECAR_SCRIPT, { ...event, action: "update" });
    expect(out).toBe(true);
    expect(jobs(calls)).toHaveLength(1);
  });

  it("skips a sidecar that describes another project, and fetches nothing", () => {
    const { out, calls } = index(SIDECAR_SCRIPT, { ...event, rkey: "other" });
    expect(out).toBeNull();
    expect(jobs(calls)).toEqual([]);
    expect(logs(calls)).toHaveLength(1);
  });

  it("skips one with no security contact", () => {
    const record = sidecar(DID, "probe").replace(`security = { { email = "security@example.com" } }`, "security = {}");
    expect(index(SIDECAR_SCRIPT, { ...event, record }).out).toBeNull();
  });

  it("does nothing on delete", () => {
    const { out, calls } = index(SIDECAR_SCRIPT, { ...event, action: "delete", record: undefined });
    expect(out).toBeNull();
    expect(jobs(calls)).toEqual([]);
    expect(writes(calls)).toEqual([]);
  });
});

describe("software.release.project", () => {
  const event = { collection: "software.release.project", rkey: "probe", record: `{ ["$type"] = "software.release.project", name = "probe" }` };
  const renamed = `"${at(DID, "software.release.project", "probe-2")}"`;

  it("skips a project with no sidecar", () => {
    const { out, calls } = index(PROJECT_SCRIPT, event, { setup: noSidecar(DID, "probe") });
    expect(out).toBeNull();
    expect(jobs(calls)).toEqual([]);
  });

  it("skips a record whose name is not its key", () => {
    expect(index(PROJECT_SCRIPT, { ...event, record: `{ ["$type"] = "software.release.project", name = "other" }` }).out).toBeNull();
  });

  it("skips a key that is not a project name", () => {
    expect(index(PROJECT_SCRIPT, { ...event, rkey: "Probe", record: `{ name = "Probe" }` }).out).toBeNull();
  });

  it("accepts an update that only adds renamedTo", () => {
    const { out } = index(PROJECT_SCRIPT, { ...event, action: "update", record: `{ ["$type"] = "software.release.project", name = "probe", renamedTo = ${renamed} }` });
    expect(out).toBe(true);
  });

  it("refuses a renamedTo that is not a project", () => {
    const { out } = index(PROJECT_SCRIPT, { ...event, action: "update", record: `{ ["$type"] = "software.release.project", name = "probe", renamedTo = "${MANIFEST_URI}" }` });
    expect(out).toBeNull();
  });

  it("refuses and logs any other update", () => {
    const { out, calls } = index(PROJECT_SCRIPT, {
      ...event,
      action: "update",
      record: `{ ["$type"] = "software.release.project", name = "probe", parent = "${OTHER_PROJECT_URI}" }`,
    });
    expect(out).toBeNull();
    expect(logs(calls)).toHaveLength(1);
  });

  it("refuses an update that changes or drops renamedTo once set", () => {
    const setup = `__indexed["${PROJECT_URI}"].record.renamedTo = ${renamed}`;
    const changed = index(PROJECT_SCRIPT, {
      ...event,
      action: "update",
      record: `{ ["$type"] = "software.release.project", name = "probe", renamedTo = "${OTHER_PROJECT_URI}" }`,
    }, { setup });
    expect(changed.out).toBeNull();
    const dropped = index(PROJECT_SCRIPT, { ...event, action: "update" }, { setup });
    expect(dropped.out).toBeNull();
  });

  it("stores an update of a project it never saw, as the first record", () => {
    const { out } = index(PROJECT_SCRIPT, { ...event, action: "update" }, { setup: unindex(PROJECT_URI) });
    expect(out).toBe(true);
  });

  it("skips a replayed create quietly", () => {
    const { out, calls } = index(PROJECT_SCRIPT, event);
    expect(out).toBeNull();
    expect(logs(calls)).toEqual([]);
  });
});

describe("software.release.manifest", () => {
  const event = { collection: "software.release.manifest", rkey: "3knew", record: manifest() };

  it("stores a manifest with a valid artifact and enqueues nothing", () => {
    const { out, calls } = index(MANIFEST_SCRIPT, event);
    expect(out).toBe(true);
    expect(jobs(calls)).toEqual([]);
    expect(writes(calls)).toEqual([]);
  });

  it("skips one whose project has no sidecar", () => {
    const { out, calls } = index(MANIFEST_SCRIPT, event, { setup: noSidecar(DID, "probe") });
    expect(out).toBeNull();
    expect(jobs(calls)).toEqual([]);
  });

  it("skips one naming a project of another DID", () => {
    const record = manifest(at(EVE, "software.release.project", "probe"));
    expect(index(MANIFEST_SCRIPT, { ...event, record }).out).toBeNull();
  });

  it("skips one whose project is not indexed", () => {
    expect(index(MANIFEST_SCRIPT, event, { setup: unindex(PROJECT_URI) }).out).toBeNull();
  });

  it("skips one with no plugin artifact", () => {
    const record = `{ project = "${PROJECT_URI}", artifacts = { { ["$type"] = "something.else" } } }`;
    expect(index(MANIFEST_SCRIPT, { ...event, record }).out).toBeNull();
  });

  it("skips one whose artifact breaks the artifact rules", () => {
    const record = manifest(PROJECT_URI, ARTIFACT.replace(`license = "MIT",`, ""));
    expect(index(MANIFEST_SCRIPT, { ...event, record }).out).toBeNull();
  });

  it("skips one of another plugin type than the sidecar declares", () => {
    const setup = `__indexed["${SIDECAR_URI}"].record.pluginType = "auth"`;
    expect(index(MANIFEST_SCRIPT, event, { setup }).out).toBeNull();
  });

  it("keeps the first record on update and marks the versions using it suspect", () => {
    const { out, calls } = index(MANIFEST_SCRIPT, { ...event, rkey: "3kmanifest", action: "update" });
    expect(out).toBeNull();
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        collection: "at.happyproto.registry.versionState",
        rkey: `${DID}:probe:1.0.0`,
        did: HP,
        body: expect.objectContaining({ suspect: true, availability: "available" }),
      }),
    ]);
    expect(logs(calls).some((l) => l.level === "warn")).toBe(true);
  });

  it("skips a replayed create quietly", () => {
    const { out, calls } = index(MANIFEST_SCRIPT, { ...event, rkey: "3kmanifest" });
    expect(out).toBeNull();
    expect(writes(calls)).toEqual([]);
  });

  it("treats a different create at a stored key as a rewrite", () => {
    const record = manifest(PROJECT_URI, ARTIFACT.replace(`"MIT"`, `"Apache-2.0"`));
    const { out, calls } = index(MANIFEST_SCRIPT, { ...event, rkey: "3kmanifest", record });
    expect(out).toBeNull();
    expect(writes(calls).map((w) => w.body.suspect)).toEqual([true]);
  });

  it("marks the versions using it deleted at source on delete, and keeps the row", () => {
    const { out, calls } = index(MANIFEST_SCRIPT, { ...event, rkey: "3kmanifest", action: "delete", record: undefined });
    expect(out).toBeNull();
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        rkey: `${DID}:probe:1.0.0`,
        body: expect.objectContaining({ availability: "deletedAtSource", suspect: false }),
      }),
    ]);
  });
});

describe("software.release.version", () => {
  const event = { collection: "software.release.version", rkey: "probe:1.1.0", record: versionRecord({ version: "1.1.0" }) };
  const NEW_STATE = `${DID}:probe:1.1.0`;

  it("stores it, starts its state pending and enqueues the copy", () => {
    const { out, calls } = index(VERSION_SCRIPT, event);
    expect(out).toBe(true);
    expect(writes(calls)).toEqual([
      {
        fn: "save_local",
        collection: "at.happyproto.registry.versionState",
        rkey: NEW_STATE,
        did: HP,
        body: {
          did: DID,
          name: "probe",
          version: "1.1.0",
          uri: at(DID, "software.release.version", "probe:1.1.0"),
          manifestUri: MANIFEST_URI,
          manifestCid: "bafymanifest",
          availability: "pending",
          suspect: false,
        },
      },
    ]);
    expect(jobs(calls)).toEqual([
      { fn: "create", job_type: "registry.copy-version", input: { did: DID, name: "probe", version: "1.1.0" } },
    ]);
  });

  it("keeps a suspect mark already on its state", () => {
    const setup = `__indexed["${STATE_URI(NEW_STATE)}"] = { record = { suspect = true, availability = "deletedAtSource" } }`;
    const { calls } = index(VERSION_SCRIPT, event, { setup });
    expect(writes(calls)[0].body).toMatchObject({ suspect: true, availability: "pending" });
  });

  it("fetches a changelog that is a document in the publisher's repo", () => {
    const doc = at(DID, "site.standard.document", "3kdoc");
    const record = versionRecord({ version: "1.1.0", extra: `changelog = "${doc}",` });
    const { calls } = index(VERSION_SCRIPT, { ...event, record });
    expect(jobs(calls)).toContainEqual({
      fn: "create",
      job_type: "registry.fetch-changelog",
      input: { did: DID, name: "probe", version: "1.1.0", uri: doc },
    });
  });

  for (const [what, changelog] of [
    ["a web page", "https://example.com/changelog"],
    ["a document in another repo", at(EVE, "site.standard.document", "3kdoc")],
    ["another kind of record", at(DID, "app.bsky.feed.post", "3kpost")],
  ]) {
    it(`does not fetch a changelog that is ${what}`, () => {
      const record = versionRecord({ version: "1.1.0", extra: `changelog = "${changelog}",` });
      const { out, calls } = index(VERSION_SCRIPT, { ...event, record });
      expect(out).toBe(true);
      expect(jobs(calls).map((j) => j.job_type)).toEqual(["registry.copy-version"]);
    });
  }

  it("skips a version whose project has no sidecar, with no state and no job", () => {
    const { out, calls } = index(VERSION_SCRIPT, event, { setup: noSidecar(DID, "probe") });
    expect(out).toBeNull();
    expect(writes(calls)).toEqual([]);
    expect(jobs(calls)).toEqual([]);
  });

  for (const rkey of ["probe", "probe:1.1.0:x", "Probe:1.1.0", "probe:v1.1.0"]) {
    it(`skips the key ${rkey}`, () => {
      const { out, calls } = index(VERSION_SCRIPT, { ...event, rkey });
      expect(out).toBeNull();
      expect(writes(calls)).toEqual([]);
    });
  }

  it("skips one whose version is not its key's", () => {
    expect(index(VERSION_SCRIPT, { ...event, record: versionRecord({ version: "1.2.0" }) }).out).toBeNull();
  });

  it("skips one whose project is not its key's", () => {
    const record = versionRecord({ version: "1.1.0", project: OTHER_PROJECT_URI });
    expect(index(VERSION_SCRIPT, { ...event, record }).out).toBeNull();
  });

  const refused: [string, Parameters<typeof versionRecord>[0]][] = [
    ["a manifest of another DID", { manifestUri: EVE_MANIFEST_URI, manifestCid: "bafyeve" }],
    ["a manifest of another project", { manifestUri: OTHER_MANIFEST_URI, manifestCid: "bafyother" }],
    ["a manifest not indexed", { manifestUri: at(DID, "software.release.manifest", "3kmissing") }],
    ["a manifest at another CID", { manifestCid: "bafystale" }],
    ["a manifest that is another kind of record", { manifestUri: OTHER_PROJECT_URI, manifestCid: "bafyproject2" }],
  ];
  for (const [what, fields] of refused) {
    it(`skips one pointing at ${what}`, () => {
      const { out, calls } = index(VERSION_SCRIPT, { ...event, record: versionRecord({ version: "1.1.0", ...fields }) });
      expect(out).toBeNull();
      expect(writes(calls)).toEqual([]);
      expect(jobs(calls)).toEqual([]);
    });
  }

  it("skips one pointing at another DID's manifest even when that manifest claims this project", () => {
    const setup = `__indexed["${EVE_MANIFEST_URI}"].record.project = "${PROJECT_URI}"`;
    const record = versionRecord({ version: "1.1.0", manifestUri: EVE_MANIFEST_URI, manifestCid: "bafyeve" });
    expect(index(VERSION_SCRIPT, { ...event, record }, { setup }).out).toBeNull();
  });

  it("skips one with no manifest reference", () => {
    const record = `{ project = "${PROJECT_URI}", version = "1.1.0" }`;
    expect(index(VERSION_SCRIPT, { ...event, record }).out).toBeNull();
  });

  it("keeps the first record on update and marks it suspect", () => {
    const record = versionRecord({ manifestUri: OTHER_MANIFEST_URI, manifestCid: "bafyother" });
    const { out, calls } = index(VERSION_SCRIPT, { ...event, rkey: "probe:1.0.0", action: "update", record });
    expect(out).toBeNull();
    expect(jobs(calls)).toEqual([]);
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        rkey: `${DID}:probe:1.0.0`,
        body: expect.objectContaining({ suspect: true, availability: "available", manifestUri: MANIFEST_URI }),
      }),
    ]);
    expect(logs(calls).some((l) => l.level === "warn")).toBe(true);
  });

  it("skips a replayed create quietly", () => {
    const { out, calls } = index(VERSION_SCRIPT, { ...event, rkey: "probe:1.0.0", record: versionRecord() });
    expect(out).toBeNull();
    expect(writes(calls)).toEqual([]);
    expect(jobs(calls)).toEqual([]);
  });

  it("treats a different create at a stored key as a rewrite", () => {
    const record = versionRecord({ extra: `changelog = "https://example.com",` });
    const { out, calls } = index(VERSION_SCRIPT, { ...event, rkey: "probe:1.0.0", record });
    expect(out).toBeNull();
    expect(writes(calls).map((w) => w.body.suspect)).toEqual([true]);
    expect(jobs(calls)).toEqual([]);
  });

  it("marks its state deleted at source on delete, and keeps the row", () => {
    const { out, calls } = index(VERSION_SCRIPT, { ...event, rkey: "probe:1.0.0", action: "delete", record: undefined });
    expect(out).toBeNull();
    expect(writes(calls)).toEqual([
      expect.objectContaining({
        rkey: `${DID}:probe:1.0.0`,
        body: expect.objectContaining({ availability: "deletedAtSource", manifestCid: "bafymanifest" }),
      }),
    ]);
  });
});

describe("software.release.channel", () => {
  const channel = ({ name = "latest", project = PROJECT_URI, uri = VERSION_URI, cid = "bafyversion" } = {}) =>
    `{ project = "${project}", name = "${name}", version = { uri = "${uri}", cid = "${cid}" } }`;
  const event = { collection: "software.release.channel", rkey: "probe:latest", record: channel() };

  it("stores an update, because channels move", () => {
    expect(index(CHANNEL_SCRIPT, { ...event, action: "update" }).out).toBe(true);
  });

  it("skips a channel whose project has no sidecar", () => {
    expect(index(CHANNEL_SCRIPT, event, { setup: noSidecar(DID, "probe") }).out).toBeNull();
  });

  it("skips one whose name is not its key's", () => {
    expect(index(CHANNEL_SCRIPT, { ...event, record: channel({ name: "beta" }) }).out).toBeNull();
  });

  it("skips a key that is not name:channel", () => {
    expect(index(CHANNEL_SCRIPT, { ...event, rkey: "probe" }).out).toBeNull();
  });

  it("skips one whose project is not its key's", () => {
    expect(index(CHANNEL_SCRIPT, { ...event, record: channel({ project: OTHER_PROJECT_URI }) }).out).toBeNull();
  });

  const refused: [string, Parameters<typeof channel>[0]][] = [
    ["a version of another DID", { uri: EVE_VERSION_URI, cid: "bafyeveversion" }],
    ["a version of another project", { uri: OTHER_VERSION_URI, cid: "bafyversion2" }],
    ["a version not indexed", { uri: at(DID, "software.release.version", "probe:9.9.9") }],
    ["a version at another CID", { cid: "bafystale" }],
    ["a record that is not a version", { uri: MANIFEST_URI, cid: "bafymanifest" }],
  ];
  for (const [what, fields] of refused) {
    it(`skips one pointing at ${what}`, () => {
      expect(index(CHANNEL_SCRIPT, { ...event, record: channel(fields) }).out).toBeNull();
    });
  }

  it("skips one pointing at another DID's version even when that version claims this project", () => {
    const setup = `__indexed["${EVE_VERSION_URI}"].record.project = "${PROJECT_URI}"`;
    const record = channel({ uri: EVE_VERSION_URI, cid: "bafyeveversion" });
    expect(index(CHANNEL_SCRIPT, { ...event, record }, { setup }).out).toBeNull();
  });
});

describe("software.release.status", () => {
  const status = (fields: string) => `{ subject = "${VERSION_URI}", ${fields} }`;
  const event = { collection: "software.release.status", rkey: "3knew", record: status(`status = "endOfLife"`) };

  it("stores a status about the project itself", () => {
    const record = `{ subject = "${PROJECT_URI}", status = "endOfLife" }`;
    expect(index(STATUS_SCRIPT, { ...event, record }).out).toBe(true);
  });

  it("stores a status of a type it does not act on", () => {
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = "yanked"`) }).out).toBe(true);
  });

  it("skips one whose project has no sidecar", () => {
    expect(index(STATUS_SCRIPT, event, { setup: noSidecar(DID, "probe") }).out).toBeNull();
  });

  for (const [what, subject] of [
    ["of another DID", EVE_VERSION_URI],
    ["not indexed", at(DID, "software.release.version", "probe:9.9.9")],
    ["that is neither a version nor a project", MANIFEST_URI],
    ["that is not an at-uri", "https://example.com"],
  ]) {
    it(`skips one about a subject ${what}`, () => {
      const record = `{ subject = "${subject}", status = "endOfLife" }`;
      expect(index(STATUS_SCRIPT, { ...event, record }).out).toBeNull();
    });
  }

  it("skips one with no status string", () => {
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = 7`) }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = ""`) }).out).toBeNull();
  });

  it("requires a valid supersededBy version for supersededBy", () => {
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = "supersededBy"`) }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = "supersededBy", supersededBy = "v2"`) }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = "supersededBy", supersededBy = "2.0.0"`) }).out).toBe(true);
  });

  it("requires withdraws to name a stored status of the same DID about the same subject", () => {
    const withdraw = (target: string) => status(`status = "withdrawn", withdraws = "${target}"`);
    expect(index(STATUS_SCRIPT, { ...event, record: status(`status = "withdrawn"`) }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: withdraw(at(EVE, "software.release.status", "3keve")) }).out).toBeNull();
    // Even one claiming this subject: another repo cannot cancel this one's statements.
    const forged = `__indexed["${at(EVE, "software.release.status", "3keve")}"].record.subject = "${VERSION_URI}"`;
    expect(index(STATUS_SCRIPT, { ...event, record: withdraw(at(EVE, "software.release.status", "3keve")) }, { setup: forged }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: withdraw(at(DID, "software.release.status", "3kmissing")) }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: withdraw(VERSION_URI) }).out).toBeNull();
    const elsewhere = `__indexed["${STATUS_URI}"].record.subject = "${PROJECT_URI}"`;
    expect(index(STATUS_SCRIPT, { ...event, record: withdraw(STATUS_URI) }, { setup: elsewhere }).out).toBeNull();
    expect(index(STATUS_SCRIPT, { ...event, record: withdraw(STATUS_URI) }).out).toBe(true);
  });

  it("refuses an update, since statuses are append-only", () => {
    const { out, calls } = index(STATUS_SCRIPT, { ...event, rkey: "3kstatus", action: "update" });
    expect(out).toBeNull();
    expect(logs(calls)).toHaveLength(1);
  });

  it("skips a replayed create quietly", () => {
    const record = `{ subject = "${VERSION_URI}", status = "endOfSupport" }`;
    const { out, calls } = index(STATUS_SCRIPT, { ...event, rkey: "3kstatus", record });
    expect(out).toBeNull();
    expect(logs(calls)).toEqual([]);
  });
});
