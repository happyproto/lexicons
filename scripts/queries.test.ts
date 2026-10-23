/**
 * The registry's read API, executed against an index held in a Lua table.
 * Every query is anonymous and reads only what the indexers and jobs stored:
 * the publisher's records, and the registry's own state rows under
 * HAPPYPROTO_DID. The publisher's PDS is faked through `__reply` for the
 * changelog refresh, and the blob store through `__blobs`.
 */
import { describe, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonToLex, Lexicons } from "@atproto/lexicon";
import { HARNESS } from "./harness";
import { findLua } from "./lua";
import { generated, it } from "./procedure";

const SEARCH = await generated("src/at/happyproto/registry/searchProjects.lua");
const GET_PROJECT = await generated("src/at/happyproto/registry/getProject.lua");
const LIST_VERSIONS = await generated("src/at/happyproto/registry/listVersions.lua");
const GET_VERSION = await generated("src/at/happyproto/registry/getVersion.lua");
const RESOLVE = await generated("src/at/happyproto/registry/resolveChannel.lua");
const GET_ARTIFACT = await generated("src/at/happyproto/registry/getArtifact.lua");
const CHANGELOG_JOB = await generated("jobs/registry.fetch-changelog.lua");

const DID = "did:plc:pub";
const EVE = "did:plc:eve";
const HP = "did:plc:hp";
const PDS = "http://pds.test";

const at = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
const PROJECT_URI = at(DID, "software.release.project", "probe");
const SIDECAR_URI = at(DID, "at.happyproto.registry.project", "probe");
const PUBLICATION_URI = at(DID, "site.standard.publication", "probe");
const MANIFEST_1 = at(DID, "software.release.manifest", "3kmanifest1");
const MANIFEST_2 = at(DID, "software.release.manifest", "3kmanifest2");
const VERSION_1 = at(DID, "software.release.version", "probe:1.0.0");
const VERSION_2 = at(DID, "software.release.version", "probe:1.1.0-beta.1");
const DOCUMENT_URI = at(DID, "site.standard.document", "3kchangelog");
const OLD_PROJECT_URI = at(DID, "software.release.project", "old");
const state = (rkey: string) => at(HP, "at.happyproto.registry.versionState", `${DID}:${rkey}`);
const PROJECT_STATE_URI = at(HP, "at.happyproto.registry.projectState", `${DID}:probe`);
const CHANGELOG_URI = at(HP, "at.happyproto.registry.changelogCache", `${DID}:probe:1.0.0`);

const CIDS = {
  package1: "bafkreipackageone",
  manifest1: "bafkreimanifestone",
  banner1: "bafkreibannerone",
  package2: "bafkreipackagetwo",
  manifest2: "bafkreimanifesttwo",
  banner2: "bafkreibannertwo",
  shot2: "bafkreishottwo",
  icon: "bafkreiicon",
  stray: "bafkreistray",
};

const blob = (cid: string, mimeType: string, size: number) =>
  `{ ["$type"] = "blob", ref = { ["$link"] = "${cid}" }, mimeType = "${mimeType}", size = ${size} }`;

const artifact = (pkg: string, manifest: string, extra: string) => `{
  ["$type"] = "at.happyproto.plugin.v1",
  package = ${blob(pkg, "application/wasm", 40)},
  manifest = ${blob(manifest, "application/json", 20)},
  pluginType = "interpreter",
  apiVersion = "2",
  capabilities = { "library:call" },
  languageId = "lua",
  fileExtensions = { "lua" },
  license = "MIT",
  sections = { description = "Runs Lua." },
  ${extra}
}`;

const recordUrl = (collection: string, rkey: string) =>
  `${PDS}/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Apub&collection=${collection}&rkey=${rkey}`;

/**
 * The index before each query.
 *
 * did:plc:pub publishes two plugin projects:
 *   - probe (interpreter): 1.0.0 (available, on `latest`, with a changelog)
 *     and 1.1.0-beta.1 (pending, suspect, deprecated by its own status, on
 *     `beta`). Its publication is cached with an icon.
 *   - old (library): retired by a project status, with no cached publication.
 * did:plc:eve writes a status about probe 1.0.0 that must not count.
 *
 * `__blobs[cid]` is the blob store, holding every copied blob and one stray
 * blob that no held entry names.
 */
const STUBS = String.raw`
__indexed = {}
local __order = 0
local function put(uri, cid, record, indexed_at)
  __order = __order + 1
  local did, collection, rkey = uri:match("^at://([^/]+)/([^/]+)/(.+)$")
  __indexed[uri] = {
    uri = uri, did = did, collection = collection, rkey = rkey, cid = cid, record = record,
    indexed_at = indexed_at or string.format("2026-10-23T00:00:%02dZ", __order),
  }
end
__put = put

put("${PROJECT_URI}", "bafyproject", { ["$type"] = "software.release.project", name = "probe" })
put("${SIDECAR_URI}", "bafysidecar", {
  ["$type"] = "at.happyproto.registry.project",
  project = "${PROJECT_URI}",
  publication = { uri = "${PUBLICATION_URI}", cid = "bafypub" },
  pluginType = "interpreter",
  keywords = { "lua", "scripting" },
  authors = { { name = "Trezy", url = "https://trezy.com" } },
  security = { { email = "security@example.com" } },
})
put("${PROJECT_STATE_URI}", nil, {
  did = "${DID}", name = "probe", fetchedAt = "2026-10-23T00:00:00Z",
  publication = {
    uri = "${PUBLICATION_URI}", cid = "bafypub", name = "Probe", description = "Pokes at things.",
    url = "https://happyproto.at/plugins/${DID}/probe", icon = "${CIDS.icon}", iconMimeType = "image/png",
  },
  suspectManifests = { ["${MANIFEST_2}"] = true },
})
put("${MANIFEST_1}", "bafymanifestone", {
  ["$type"] = "software.release.manifest", project = "${PROJECT_URI}",
  artifacts = { ${artifact(CIDS.package1, CIDS.manifest1, `banner = { image = ${blob(CIDS.banner1, "image/png", 6)}, width = 1200, height = 400, alt = "Probe" },`)} },
})
put("${MANIFEST_2}", "bafymanifesttwo", {
  ["$type"] = "software.release.manifest", project = "${PROJECT_URI}",
  artifacts = { ${artifact(CIDS.package2, CIDS.manifest2, `banner = { image = ${blob(CIDS.banner2, "image/png", 6)}, width = 1000, height = 300 },
  screenshots = { { image = ${blob(CIDS.shot2, "image/webp", 8)}, width = 1280, height = 720 } },`)} },
})
put("${VERSION_1}", "bafyversionone", {
  ["$type"] = "software.release.version", project = "${PROJECT_URI}", version = "1.0.0",
  manifest = { uri = "${MANIFEST_1}", cid = "bafymanifestone" },
  changelog = "${DOCUMENT_URI}",
})
put("${VERSION_2}", "bafyversiontwo", {
  ["$type"] = "software.release.version", project = "${PROJECT_URI}", version = "1.1.0-beta.1",
  manifest = { uri = "${MANIFEST_2}", cid = "bafymanifesttwo" },
})
put("${state("probe:1.0.0")}", nil, {
  did = "${DID}", name = "probe", version = "1.0.0", uri = "${VERSION_1}",
  manifestUri = "${MANIFEST_1}", manifestCid = "bafymanifestone",
  availability = "available", suspect = false,
  held = {
    package = { cid = "${CIDS.package1}", mimeType = "application/wasm", size = 40 },
    manifest = { cid = "${CIDS.manifest1}", mimeType = "application/json", size = 20 },
    banner = { cid = "${CIDS.banner1}", mimeType = "image/png", size = 6 },
  },
})
put("${state("probe:1.1.0-beta.1")}", nil, {
  did = "${DID}", name = "probe", version = "1.1.0-beta.1", uri = "${VERSION_2}",
  manifestUri = "${MANIFEST_2}", manifestCid = "bafymanifesttwo",
  availability = "pending", suspect = true,
  held = {
    package = { cid = "${CIDS.package2}", mimeType = "application/wasm", size = 40 },
    ["screenshot.1"] = { cid = "${CIDS.shot2}", mimeType = "image/webp", size = 8 },
  },
  failed = { manifest = "the PDS answered 500" },
})
put("${at(DID, "software.release.channel", "probe:latest")}", "bafylatest", {
  ["$type"] = "software.release.channel", project = "${PROJECT_URI}", name = "latest",
  version = { uri = "${VERSION_1}", cid = "bafyversionone" },
})
put("${at(DID, "software.release.channel", "probe:beta")}", "bafybeta", {
  ["$type"] = "software.release.channel", project = "${PROJECT_URI}", name = "beta",
  version = { uri = "${VERSION_2}", cid = "bafyversiontwo" },
})
put("${at(DID, "software.release.status", "3kstatus1")}", "bafystatus1", {
  subject = "${VERSION_2}", status = "endOfSupport", reason = "Use 1.0.0.",
})
put("${at(EVE, "software.release.status", "3kstatus2")}", "bafystatus2", {
  subject = "${VERSION_1}", status = "endOfLife", reason = "Eve says so.",
})
put("${CHANGELOG_URI}", nil, {
  uri = "${DOCUMENT_URI}", title = "Probe 1.0.0", markdown = "# Old notes", fetchedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
})

put("${OLD_PROJECT_URI}", "bafyold", { ["$type"] = "software.release.project", name = "old" })
put("${at(DID, "at.happyproto.registry.project", "old")}", "bafyoldsidecar", {
  project = "${OLD_PROJECT_URI}",
  publication = { uri = "${at(DID, "site.standard.publication", "old")}", cid = "bafyoldpub" },
  pluginType = "library",
  authors = { { name = "Trezy" } },
  security = { { email = "security@example.com" } },
})
put("${at(DID, "software.release.status", "3kstatus3")}", "bafystatus3", {
  subject = "${OLD_PROJECT_URI}", status = "endOfLife",
})

__blobs = {}
for _, cid in ipairs({ "${CIDS.package1}", "${CIDS.manifest1}", "${CIDS.banner1}", "${CIDS.package2}",
    "${CIDS.shot2}", "${CIDS.icon}", "${CIDS.stray}" }) do
  __blobs[cid] = { cid = cid, mime_type = "application/octet-stream", size = 99 }
end

__handles = { ["${DID}"] = "pub.test" }

local function field(record, path)
  local v = record
  for part in path:gmatch("[^.]+") do
    if type(v) ~= "table" then return nil end
    v = v[part]
  end
  return v
end

local function like(text, pattern)
  local parts = {}
  for piece in (pattern .. "%"):gmatch("([^%%]*)%%") do
    parts[#parts + 1] = (piece:gsub("[%^%$%(%)%.%[%]%*%+%-%?]", "%%%0"))
  end
  return text:match("^" .. table.concat(parts, ".*") .. "$") ~= nil
end

package.preload["happyview.db"] = function()
  return {
    get = function(uri) return __indexed[uri] end,
    search = function(collection, path, q, limit)
      __calls[#__calls + 1] = { fn = "search", collection = collection, field = path, q = q }
      local out = {}
      local uris = {}
      for uri in pairs(__indexed) do uris[#uris + 1] = uri end
      table.sort(uris)
      for _, uri in ipairs(uris) do
        local e = __indexed[uri]
        local v = field(e.record, path)
        if e.collection == collection and type(v) == "string" and v:lower():find(q:lower(), 1, true) then
          if #out < (limit or 10) then out[#out + 1] = e end
        end
      end
      return out
    end,
    records = function(collection)
      local q = { filters = {} }
      function q:did(d) self.owner = d; return self end
      function q:where(path, op, value) self.filters[#self.filters + 1] = { path, op, value }; return self end
      function q:sort(f, direction) self.field = f; self.descending = direction == "desc"; return self end
      function q:limit(n) self.max = n; return self end
      function q:cursor(c) self.after = c; return self end
      function q:run()
        __calls[#__calls + 1] = { fn = "records", collection = collection, filters = self.filters, after = self.after }
        local rows = {}
        for _, e in pairs(__indexed) do
          local keep = e.collection == collection and (self.owner == nil or e.did == self.owner)
          for _, f in ipairs(self.filters) do
            local v = field(e.record, f[1])
            if f[2] == "=" then
              if v ~= f[3] then keep = false end
            elseif f[2] == "like" or f[2] == "ilike" then
              local text = type(v) == "table" and __encode(v) or (v ~= nil and tostring(v) or nil)
              local pattern = f[3]
              if text and f[2] == "ilike" then text, pattern = text:lower(), pattern:lower() end
              if not text or not like(text, pattern) then keep = false end
            else
              error("unsupported operator " .. f[2])
            end
          end
          if keep then rows[#rows + 1] = e end
        end
        table.sort(rows, function(a, b)
          local x, y = a.indexed_at or "", b.indexed_at or ""
          if self.descending then return x > y end
          return x < y
        end)
        local start = tonumber(self.after or "0")
        local out = {}
        local max = self.max or 20
        for i = start + 1, math.min(#rows, start + max) do out[#out + 1] = rows[i] end
        local cursor = (start + max < #rows) and tostring(start + max) or nil
        return { records = out, cursor = cursor }
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
      __indexed[uri] = { uri = uri, did = did, collection = collection, rkey = rkey, record = body }
      return { uri = uri }
    end,
  }
end

package.preload["happyview.blobs"] = function()
  return {
    stat = function(cid)
      __calls[#__calls + 1] = { fn = "stat", cid = cid }
      return __blobs[cid]
    end,
  }
end

package.preload["happyview.atproto"] = function()
  return {
    resolve_identity = function(actor)
      __calls[#__calls + 1] = { fn = "resolve_identity", actor = actor }
      for did, handle in pairs(__handles) do
        if actor == did or actor == handle then return { did = did, handle = handle } end
      end
      error("could not resolve " .. actor)
    end,
    resolve_service_endpoint = function(did)
      if did == "${DID}" then return "${PDS}" end
      return nil
    end,
  }
end

__pds = {}
__reply = function(method, url)
  return __pds[url] or { status = 404, body = "" }
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

const lua = findLua();

type Result = { out: any; calls: any[]; indexed: Record<string, any> };

function query(script: string, input: string, { setup = "", ctx = CTX } = {}): Result {
  if (!lua) throw new Error("no lua on PATH, so the query was never executed");
  const source = [
    HARNESS,
    STUBS,
    setup,
    script,
    `local __out = handle(${input}, ${ctx})`,
    "io.write(__encode({ out = __out, calls = __calls, indexed = __indexed }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return {
    out: parsed.out ?? null,
    calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    indexed: parsed.indexed ?? {},
  };
}

const gets = (calls: any[]) => calls.filter((c) => c.fn === "get").map((c) => c.url);
const saves = (calls: any[]) => calls.filter((c) => c.fn === "save_local");

/** A changelog cached long enough ago to be refreshed. */
const STALE = `__indexed["${CHANGELOG_URI}"].record.fetchedAt = "2026-01-01T00:00:00Z"`;
const serveDocument = (markdown: string) => `
__pds["${recordUrl("site.standard.document", "3kchangelog")}"] = { status = 200, body = "DOC" }
__decoded["DOC"] = { uri = "${DOCUMENT_URI}", cid = "bafydoc", value = {
  ["$type"] = "site.standard.document", site = "${PUBLICATION_URI}", path = "/changelog/1.0.0",
  title = "Probe 1.0.0", publishedAt = "2026-10-23T00:00:00Z", textContent = "${markdown}",
} }`;

describe("every query", () => {
  const cases: [string, string, string][] = [
    ["searchProjects", SEARCH, `{}`],
    ["getProject", GET_PROJECT, `{ actor = "${DID}", name = "probe" }`],
    ["listVersions", LIST_VERSIONS, `{ did = "${DID}", name = "probe" }`],
    ["getVersion", GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`],
    ["resolveChannel", RESOLVE, `{ did = "${DID}", name = "probe", channel = "latest" }`],
    ["getArtifact", GET_ARTIFACT, `{ cid = "${CIDS.package1}" }`],
  ];
  for (const [name, script, input] of cases) {
    it(`${name} answers NotConfigured without HAPPYPROTO_DID`, () => {
      expect(query(script, input, { ctx: "{ env = {} }" }).out.error).toBe("NotConfigured");
    });
    it(`${name} answers an anonymous caller`, () => {
      expect(query(script, input).out.error).toBeUndefined();
    });
  }
});

describe("getProject", () => {
  it("answers the project with its channels, each with its version's state and availability", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`);
    expect(out.uri).toBe(PROJECT_URI);
    expect(out.cid).toBe("bafyproject");
    expect(out.did).toBe(DID);
    expect(out.handle).toBe("pub.test");
    expect(out.name).toBe("probe");
    expect(out.sidecar).toEqual({ uri: SIDECAR_URI, cid: "bafysidecar" });
    expect(out.pluginType).toBe("interpreter");
    expect(out.keywords).toEqual(["lua", "scripting"]);
    expect(out.authors).toEqual([{ name: "Trezy", url: "https://trezy.com" }]);
    expect(out.security).toEqual([{ email: "security@example.com" }]);
    expect(out.channels).toEqual({
      latest: { version: "1.0.0", uri: VERSION_1, cid: "bafyversionone", state: "active", availability: "available" },
      beta: {
        version: "1.1.0-beta.1", uri: VERSION_2, cid: "bafyversiontwo", state: "deprecated", availability: "pending",
      },
    });
    expect(out.lifecycle).toEqual({ state: "active" });
    expect(out.indexedAt).toBe("2026-10-23T00:00:01Z");
  });

  it("takes the banner from the version the latest channel points at", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`);
    expect(out.banner).toEqual({ cid: CIDS.banner1, width: 1200, height: 400, alt: "Probe" });
  });

  it("has no banner when latest's version has none", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, {
      setup: `__indexed["${at(DID, "software.release.channel", "probe:latest")}"] = nil`,
    });
    expect(out.banner).toBeUndefined();
    expect(Object.keys(out.channels)).toEqual(["beta"]);
  });

  it("keys channels by their record key and leaves out one whose name disagrees", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, {
      setup: `__indexed["${at(DID, "software.release.channel", "probe:beta")}"].record.name = "alpha"`,
    });
    expect(Object.keys(out.channels)).toEqual(["latest"]);
  });

  it("answers the cached publication without the fields only the registry uses", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`);
    expect(out.publication).toEqual({
      uri: PUBLICATION_URI, cid: "bafypub", name: "Probe", description: "Pokes at things.",
      url: `https://happyproto.at/plugins/${DID}/probe`, icon: CIDS.icon,
    });
  });

  it("falls back to the pinned publication and the project's name before the publication is cached", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "old" }`);
    expect(out.publication).toEqual({
      uri: at(DID, "site.standard.publication", "old"), cid: "bafyoldpub", name: "old",
      url: `https://happyproto.at/plugins/${DID}/old`,
    });
    expect(out.lifecycle).toEqual({ state: "retired" });
    expect(out.channels).toEqual({});
    expect(out.keywords).toEqual({}); // an empty list, as the harness encodes it
  });

  it("resolves a handle, and answers ActorNotFound for one that does not resolve", () => {
    expect(query(GET_PROJECT, `{ actor = "pub.test", name = "probe" }`).out.uri).toBe(PROJECT_URI);
    expect(query(GET_PROJECT, `{ actor = "nobody.test", name = "probe" }`).out.error).toBe("ActorNotFound");
  });

  it("answers ProjectNotFound without a sidecar, or for a name that is not one", () => {
    expect(
      query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, { setup: `__indexed["${SIDECAR_URI}"] = nil` }).out.error,
    ).toBe("ProjectNotFound");
    expect(query(GET_PROJECT, `{ actor = "${DID}", name = "Nope!" }`).out.error).toBe("ProjectNotFound");
    expect(query(GET_PROJECT, `{ actor = "${EVE}", name = "probe" }`).out.error).toBe("ProjectNotFound");
  });

  it("still answers for a project whose sidecar was deleted, since its versions stay served", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, {
      setup: `__indexed["${PROJECT_STATE_URI}"].record.sidecarDeleted = true`,
    });
    expect(out.uri).toBe(PROJECT_URI);
    expect(out.sidecarDeleted).toBeUndefined();
  });

  it("answers authors and security contacts with only the fields the lexicon declares", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, {
      setup: `local s = __indexed["${SIDECAR_URI}"].record
s.authors = { { name = "Trezy", url = "https://trezy.com", email = "t@example.com", avatar = string.rep("x", 100000), nested = { a = 1 } } }
s.security = { { email = "security@example.com", pgp = string.rep("k", 100000), name = "Not declared" } }`,
    });
    expect(out.authors).toEqual([{ name: "Trezy", url: "https://trezy.com", email: "t@example.com" }]);
    expect(out.security).toEqual([{ email: "security@example.com" }]);
  });

  it("answers ProjectNotFound for a sidecar whose project is not indexed", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, { setup: `__indexed["${PROJECT_URI}"] = nil` });
    expect(out.error).toBe("ProjectNotFound");
  });

  it("answers no handle when the publisher's has none, and still answers", () => {
    const { out } = query(GET_PROJECT, `{ actor = "${DID}", name = "probe" }`, { setup: `__handles = {}` });
    expect(out.uri).toBe(PROJECT_URI);
    expect(out.handle).toBeUndefined();
  });
});

describe("searchProjects", () => {
  it("lists plugins most recently indexed first, leaving out retired ones", () => {
    const { out } = query(SEARCH, `{}`);
    expect(out.projects.map((p: any) => p.name)).toEqual(["probe"]);
    expect(out.projects[0].channels.latest.version).toBe("1.0.0");
  });

  it("includes retired projects when includeRetired is set", () => {
    for (const flag of ["true", `"true"`]) {
      const { out } = query(SEARCH, `{ includeRetired = ${flag} }`);
      expect(out.projects.map((p: any) => p.name)).toEqual(["old", "probe"]);
      expect(out.projects[0].lifecycle.state).toBe("retired");
    }
  });

  it("filters by pluginType", () => {
    const { out } = query(SEARCH, `{ pluginType = "library", includeRetired = true }`);
    expect(out.projects.map((p: any) => p.name)).toEqual(["old"]);
    expect(query(SEARCH, `{ pluginType = "auth" }`).out.projects).toEqual({});
  });

  it("pages with a cursor", () => {
    const first = query(SEARCH, `{ limit = 1, includeRetired = true }`).out;
    expect(first.projects.map((p: any) => p.name)).toEqual(["old"]);
    expect(first.cursor).toBe("1");
    const second = query(SEARCH, `{ limit = 1, includeRetired = true, cursor = "1" }`).out;
    expect(second.projects.map((p: any) => p.name)).toEqual(["probe"]);
    expect(second.cursor).toBeUndefined();
  });

  it("searches display names and project names", () => {
    const byDisplay = query(SEARCH, `{ q = "Prob" }`);
    expect(byDisplay.out.projects.map((p: any) => p.name)).toEqual(["probe"]);
    expect(byDisplay.out.cursor).toBeUndefined();
    // old has no cached publication, so only its project name can match.
    expect(query(SEARCH, `{ q = "ol", includeRetired = true }`).out.projects.map((p: any) => p.name)).toEqual(["old"]);
    expect(query(SEARCH, `{ q = "ol" }`).out.projects).toEqual({});
  });

  it("finds a project once when both its names match", () => {
    const { out } = query(SEARCH, `{ q = "probe" }`);
    expect(out.projects.map((p: any) => p.name)).toEqual(["probe"]);
  });

  it("does not let rows outside the registry's plugins take a capped slot", () => {
    // Strangers' state rows and plain software.release projects (no sidecar)
    // that match q, each indexed before probe's rows.
    const crowd = [1, 2, 3]
      .map(
        (i) => `
      __put("${at(EVE, "at.happyproto.registry.projectState", "x")}${"${i}"}", nil, {
        did = "${EVE}", name = "probe${"${i}"}", publication = { name = "Probe ${"${i}"}" } }, "2026-01-01T00:00:0${"${i}"}Z")
      __put("${at(EVE, "software.release.project", "probe")}${"${i}"}", "bafyeve", { name = "probe${"${i}"}" }, "2026-01-01T00:00:0${"${i}"}Z")`,
      )
      .join("\n");
    const { out } = query(SEARCH, `{ q = "probe", limit = 1 }`, { setup: crowd });
    expect(out.projects.map((p: any) => p.name)).toEqual(["probe"]);
    const byName = query(SEARCH, `{ q = "ol", limit = 1, includeRetired = true }`, { setup: crowd });
    expect(byName.out.projects.map((p: any) => p.name)).toEqual(["old"]);
  });

  it("matches q only against the project name in a sidecar's project", () => {
    // Every sidecar's project uri contains "release" and the publisher's DID.
    expect(query(SEARCH, `{ q = "release", includeRetired = true }`).out.projects).toEqual({});
    expect(query(SEARCH, `{ q = "plc", includeRetired = true }`).out.projects).toEqual({});
  });

  it("keeps listing an indexed project whose sidecar was deleted", () => {
    const { out } = query(SEARCH, `{}`, { setup: `__indexed["${PROJECT_STATE_URI}"].record.sidecarDeleted = true` });
    expect(out.projects.map((p: any) => p.name)).toEqual(["probe"]);
    const found = query(SEARCH, `{ q = "Probe" }`, { setup: `__indexed["${PROJECT_STATE_URI}"].record.sidecarDeleted = true` });
    expect(found.out.projects.map((p: any) => p.name)).toEqual(["probe"]);
  });

  it("leaves out a sidecar whose project is not indexed, so sidecars alone fill no page", () => {
    // Eve writes only sidecars, newer than every real project.
    const sidecars = [1, 2, 3]
      .map(
        (i) => `__put("${at(EVE, "at.happyproto.registry.project", "spam")}${i}", "bafyspam", {
  project = "${at(EVE, "software.release.project", "spam")}${i}",
  publication = { uri = "${at(EVE, "site.standard.publication", "spam")}${i}", cid = "bafyspam" },
  pluginType = "library", authors = { { name = "Eve" } }, security = { { email = "e@example.com" } },
}, "2026-12-01T00:00:0${i}Z")`,
      )
      .join("\n");
    const { out } = query(SEARCH, `{ includeRetired = true }`, { setup: sidecars });
    expect(out.projects.map((p: any) => p.name)).toEqual(["old", "probe"]);
    expect(query(SEARCH, `{ q = "spam" }`, { setup: sidecars }).out.projects).toEqual({});
  });

  it("ignores state rows that are not the registry's own", () => {
    const { out } = query(SEARCH, `{ q = "Zebra" }`, {
      setup: `__put("${at(EVE, "at.happyproto.registry.projectState", `${DID}:probe`)}", nil, {
        did = "${DID}", name = "probe", publication = { name = "Zebra" } })`,
    });
    expect(out.projects).toEqual({});
  });
});

describe("getVersion", () => {
  it("answers the version with its manifest, artifact, availability and lifecycle", () => {
    const { out } = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`);
    expect(out.uri).toBe(VERSION_1);
    expect(out.cid).toBe("bafyversionone");
    expect(out.did).toBe(DID);
    expect(out.name).toBe("probe");
    expect(out.version).toBe("1.0.0");
    expect(out.manifest).toEqual({ uri: MANIFEST_1, cid: "bafymanifestone" });
    expect(out.artifact.package.ref.$link).toBe(CIDS.package1);
    expect(out.artifact.banner.alt).toBe("Probe");
    expect(out.availability).toBe("available");
    expect(out.suspect).toBe(false);
    // Eve's endOfLife about this version is not the publisher's, so it counts for nothing.
    expect(out.lifecycle).toEqual({ state: "active", installable: true, events: {} });
    expect(out.indexedAt).toMatch(/^2026-10-23T/);
    expect(out.held).toBeUndefined();
    expect(out.failed).toBeUndefined();
  });

  it("answers a pending suspect version with its own lifecycle", () => {
    const { out } = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.1.0-beta.1" }`);
    expect(out.availability).toBe("pending");
    expect(out.suspect).toBe(true);
    expect(out.lifecycle).toEqual({
      state: "deprecated",
      installable: true,
      reason: "Use 1.0.0.",
      events: [{ uri: at(DID, "software.release.status", "3kstatus1"), status: "endOfSupport", reason: "Use 1.0.0." }],
    });
    expect(out.changelog).toBeUndefined();
  });

  it("combines the project's lifecycle with the version's", () => {
    const { out } = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, {
      setup: `__put("${at(DID, "software.release.status", "3kstatus4")}", "bafys4", {
        subject = "${PROJECT_URI}", status = "endOfDistribution", reason = "Gone." })`,
    });
    expect(out.lifecycle.state).toBe("unavailable");
    expect(out.lifecycle.installable).toBe(false);
    expect(out.lifecycle.reason).toBe("Gone.");
  });

  it("answers the cached changelog without fetching while it is fresh", () => {
    const r = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, { setup: serveDocument("# New") });
    expect(r.out.changelog.uri).toBe(DOCUMENT_URI);
    expect(r.out.changelog.title).toBe("Probe 1.0.0");
    expect(r.out.changelog.markdown).toBe("# Old notes");
    expect(r.out.changelog.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(gets(r.calls)).toHaveLength(0);
  });

  it("refreshes a changelog cached more than an hour ago", () => {
    const r = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, {
      setup: STALE + "\n" + serveDocument("# New"),
    });
    expect(gets(r.calls)).toEqual([recordUrl("site.standard.document", "3kchangelog")]);
    expect(r.out.changelog.markdown).toBe("# New");
    expect(r.out.changelog.fetchedAt).not.toBe("2026-01-01T00:00:00Z");
    expect(saves(r.calls)).toHaveLength(1);
    expect(r.indexed[CHANGELOG_URI].record.markdown).toBe("# New");
  });

  it("keeps the stale changelog when the refresh fails", () => {
    for (const setup of [
      // The PDS is down.
      `__pds["${recordUrl("site.standard.document", "3kchangelog")}"] = { status = 500, body = "" }`,
      // The document moved to another publication.
      serveDocument("# New") + `\n__decoded["DOC"].value.site = "${at(DID, "site.standard.publication", "other")}"`,
      // The http call raises.
      `__reply = function() error("connection reset") end`,
    ]) {
      const r = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, { setup: STALE + "\n" + setup });
      expect(r.out.changelog.markdown).toBe("# Old notes");
      expect(r.out.changelog.fetchedAt).toBe("2026-01-01T00:00:00Z");
      // The content is kept and only the attempt is stamped.
      expect(saves(r.calls)).toHaveLength(1);
      const kept = r.indexed[CHANGELOG_URI].record;
      expect(kept.markdown).toBe("# Old notes");
      expect(kept.fetchedAt).toBe("2026-01-01T00:00:00Z");
      expect(kept.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    }
  });

  it("does not retry a failed refresh within the hour", () => {
    const r = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, {
      setup: STALE + `\n__indexed["${CHANGELOG_URI}"].record.checkedAt = os.date("!%Y-%m-%dT%H:%M:%SZ")\n` + serveDocument("# New"),
    });
    expect(gets(r.calls)).toHaveLength(0);
    expect(saves(r.calls)).toHaveLength(0);
    expect(r.out.changelog.markdown).toBe("# Old notes");
  });

  it("retries a failed refresh once the hour has passed", () => {
    const r = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, {
      setup: STALE + `\n__indexed["${CHANGELOG_URI}"].record.checkedAt = "2026-01-01T00:30:00Z"\n` + serveDocument("# New"),
    });
    expect(gets(r.calls)).toHaveLength(1);
    expect(r.out.changelog.markdown).toBe("# New");
  });

  it("refreshes in resolveChannel as in getVersion", () => {
    const r = query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "latest" }`, { setup: STALE + "\n" + serveDocument("# New") });
    expect(r.out.changelog.markdown).toBe("# New");
  });

  it("answers no changelog from a cache of a document the version does not link", () => {
    const { out } = query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, {
      setup: `__indexed["${VERSION_1}"].record.changelog = "${at(DID, "site.standard.document", "3kother")}"`,
    });
    expect(out.changelog).toBeUndefined();
  });

  it("answers VersionNotFound for a version that is not indexed", () => {
    for (const input of [
      `{ did = "${DID}", name = "probe", version = "9.9.9" }`,
      `{ did = "${EVE}", name = "probe", version = "1.0.0" }`,
      `{ did = "not a did", name = "probe", version = "1.0.0" }`,
      `{ did = "${DID}", name = "probe", version = "1.0" }`,
    ]) {
      expect(query(GET_VERSION, input).out.error).toBe("VersionNotFound");
    }
    // A version written through the gateway but not yet indexed has no state.
    expect(
      query(GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.0.0" }`, {
        setup: `__indexed["${state("probe:1.0.0")}"] = nil`,
      }).out.error,
    ).toBe("VersionNotFound");
  });
});

describe("listVersions", () => {
  it("lists the project's versions, most recently indexed first", () => {
    const { out } = query(LIST_VERSIONS, `{ did = "${DID}", name = "probe" }`);
    expect(out.versions.map((v: any) => v.version)).toEqual(["1.1.0-beta.1", "1.0.0"]);
    expect(out.versions[0].suspect).toBe(true);
    expect(out.cursor).toBeUndefined();
  });

  it("pages with a cursor", () => {
    const first = query(LIST_VERSIONS, `{ did = "${DID}", name = "probe", limit = 1 }`).out;
    expect(first.versions.map((v: any) => v.version)).toEqual(["1.1.0-beta.1"]);
    const second = query(LIST_VERSIONS, `{ did = "${DID}", name = "probe", limit = 1, cursor = "${first.cursor}" }`).out;
    expect(second.versions.map((v: any) => v.version)).toEqual(["1.0.0"]);
  });

  it("serves cached changelogs without fetching, however stale", () => {
    // Three versions, each with a changelog cached long ago.
    const setup = [
      STALE,
      `__indexed["${VERSION_2}"].record.changelog = "${at(DID, "site.standard.document", "3kdoc2")}"`,
      `__put("${at(HP, "at.happyproto.registry.changelogCache", `${DID}:probe:1.1.0-beta.1`)}", nil, {
        uri = "${at(DID, "site.standard.document", "3kdoc2")}", title = "t", markdown = "two", fetchedAt = "2026-01-01T00:00:00Z" })`,
      `__put("${at(DID, "software.release.version", "probe:1.2.0")}", "bafyversionthree", {
        project = "${PROJECT_URI}", version = "1.2.0", manifest = { uri = "${MANIFEST_1}", cid = "bafymanifestone" },
        changelog = "${at(DID, "site.standard.document", "3kdoc3")}" })`,
      `__put("${state("probe:1.2.0")}", nil, { did = "${DID}", name = "probe", version = "1.2.0",
        manifestUri = "${MANIFEST_1}", manifestCid = "bafymanifestone", availability = "available", suspect = false })`,
      `__put("${at(HP, "at.happyproto.registry.changelogCache", `${DID}:probe:1.2.0`)}", nil, {
        uri = "${at(DID, "site.standard.document", "3kdoc3")}", title = "t", markdown = "three", fetchedAt = "2026-01-01T00:00:00Z" })`,
      serveDocument("# New"),
    ].join("\n");
    const r = query(LIST_VERSIONS, `{ did = "${DID}", name = "probe" }`, { setup });
    expect(r.out.versions.map((v: any) => v.changelog?.markdown)).toEqual(["three", "two", "# Old notes"]);
    expect(gets(r.calls)).toHaveLength(0);
    expect(saves(r.calls)).toHaveLength(0);
  });

  it("answers ProjectNotFound for a project with no sidecar", () => {
    expect(query(LIST_VERSIONS, `{ did = "${EVE}", name = "probe" }`).out.error).toBe("ProjectNotFound");
    expect(query(LIST_VERSIONS, `{ did = "${DID}", name = "Nope" }`).out.error).toBe("ProjectNotFound");
  });

  it("answers an empty list for a project with no versions", () => {
    expect(query(LIST_VERSIONS, `{ did = "${DID}", name = "old" }`).out.versions).toEqual({});
  });
});

describe("resolveChannel", () => {
  it("answers the version the channel points at", () => {
    const { out } = query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "beta" }`);
    expect(out.uri).toBe(VERSION_2);
    expect(out.version).toBe("1.1.0-beta.1");
    expect(out.lifecycle.state).toBe("deprecated");
  });

  it("answers a channel's version even when it is not installable, with its state", () => {
    const { out } = query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "latest" }`, {
      setup: `__put("${at(DID, "software.release.status", "3kstatus4")}", "bafys4", {
        subject = "${VERSION_1}", status = "endOfLife", kind = "security" })`,
    });
    expect(out.uri).toBe(VERSION_1);
    expect(out.lifecycle.state).toBe("retired");
    expect(out.lifecycle.installable).toBe(false);
    expect(out.lifecycle.kind).toBe("security");
  });

  it("answers ChannelNotFound for a channel record whose name disagrees with its key", () => {
    const setup = `__indexed["${at(DID, "software.release.channel", "probe:beta")}"].record.name = "alpha"`;
    expect(query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "beta" }`, { setup }).out.error).toBe("ChannelNotFound");
    expect(query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "alpha" }`, { setup }).out.error).toBe("ChannelNotFound");
  });

  it("answers ChannelNotFound for a channel that is not indexed", () => {
    expect(query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "alpha" }`).out.error).toBe("ChannelNotFound");
    expect(query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "Not:A" }`).out.error).toBe("ChannelNotFound");
  });

  it("answers VersionNotFound when the channel's version is not indexed", () => {
    expect(
      query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "beta" }`, {
        setup: `__indexed["${state("probe:1.1.0-beta.1")}"] = nil`,
      }).out.error,
    ).toBe("VersionNotFound");
    // A channel pointing outside its project is never answered as that project's.
    expect(
      query(RESOLVE, `{ did = "${DID}", name = "probe", channel = "beta" }`, {
        setup: `__indexed["${at(DID, "software.release.channel", "probe:beta")}"].record.version.uri = "${at(DID, "software.release.version", "old:1.0.0")}"`,
      }).out.error,
    ).toBe("VersionNotFound");
  });
});

const blobRef = (cid: string, mimeType: string, size: number) => ({
  $type: "blob",
  ref: { $link: cid },
  mimeType,
  size,
});

describe("getArtifact", () => {
  it("serves a held blob by CID with the type it was published as", () => {
    expect(query(GET_ARTIFACT, `{ cid = "${CIDS.package1}" }`).out).toEqual(blobRef(CIDS.package1, "application/wasm", 40));
    expect(query(GET_ARTIFACT, `{ cid = "${CIDS.shot2}" }`).out).toEqual(blobRef(CIDS.shot2, "image/webp", 8));
  });

  it("serves a cached publication icon by CID", () => {
    expect(query(GET_ARTIFACT, `{ cid = "${CIDS.icon}" }`).out).toEqual(blobRef(CIDS.icon, "image/png", 99));
  });

  it("refuses a stored CID that no held entry or icon names", () => {
    const r = query(GET_ARTIFACT, `{ cid = "${CIDS.stray}" }`);
    expect(r.out.error).toBe("ArtifactNotHeld");
  });

  it("refuses a CID that only a manifest declares but nothing holds", () => {
    // banner2 is in the beta manifest, but its copy never verified.
    expect(query(GET_ARTIFACT, `{ cid = "${CIDS.banner2}" }`).out.error).toBe("ArtifactNotHeld");
  });

  it("refuses a CID that only some other CID contains", () => {
    expect(query(GET_ARTIFACT, `{ cid = "bafkreipackage" }`).out.error).toBe("ArtifactNotHeld");
  });

  it("refuses a held CID whose bytes are missing from the store", () => {
    expect(
      query(GET_ARTIFACT, `{ cid = "${CIDS.package1}" }`, { setup: `__blobs["${CIDS.package1}"] = nil` }).out.error,
    ).toBe("ArtifactNotHeld");
  });

  it("ignores held entries in state rows that are not the registry's own", () => {
    const r = query(GET_ARTIFACT, `{ cid = "${CIDS.stray}" }`, {
      setup: `__put("${at(EVE, "at.happyproto.registry.versionState", "x")}", nil, {
        held = { package = { cid = "${CIDS.stray}", mimeType = "application/wasm", size = 1 } } })`,
    });
    expect(r.out.error).toBe("ArtifactNotHeld");
  });

  it("serves a version's blob by kind", () => {
    const v1 = `did = "${DID}", name = "probe", version = "1.0.0"`;
    expect(query(GET_ARTIFACT, `{ ${v1}, kind = "package" }`).out).toEqual(blobRef(CIDS.package1, "application/wasm", 40));
    expect(query(GET_ARTIFACT, `{ ${v1}, kind = "manifest" }`).out).toEqual(blobRef(CIDS.manifest1, "application/json", 20));
    expect(query(GET_ARTIFACT, `{ ${v1}, kind = "banner" }`).out).toEqual(blobRef(CIDS.banner1, "image/png", 6));
    expect(query(GET_ARTIFACT, `{ ${v1}, kind = "icon" }`).out).toEqual(blobRef(CIDS.icon, "image/png", 99));
  });

  it("maps a screenshot's index, counting from 0, to the held screenshot counting from 1", () => {
    const v2 = `did = "${DID}", name = "probe", version = "1.1.0-beta.1"`;
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "screenshot" }`).out).toEqual(blobRef(CIDS.shot2, "image/webp", 8));
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "screenshot", index = 0 }`).out).toEqual(blobRef(CIDS.shot2, "image/webp", 8));
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "screenshot", index = "0" }`).out).toEqual(blobRef(CIDS.shot2, "image/webp", 8));
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "screenshot", index = 1 }`).out.error).toBe("ArtifactNotHeld");
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "screenshot", index = -1 }`).out.error).toBe("ArtifactNotHeld");
  });

  it("refuses a kind the version does not hold", () => {
    const v2 = `did = "${DID}", name = "probe", version = "1.1.0-beta.1"`;
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "manifest" }`).out.error).toBe("ArtifactNotHeld");
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "banner" }`).out.error).toBe("ArtifactNotHeld");
    expect(query(GET_ARTIFACT, `{ ${v2}, kind = "failed" }`).out.error).toBe("ArtifactNotHeld");
    expect(query(GET_ARTIFACT, `{ did = "${DID}", name = "probe", version = "9.9.9", kind = "package" }`).out.error).toBe(
      "ArtifactNotHeld",
    );
    expect(query(GET_ARTIFACT, `{ did = "${DID}", name = "old", version = "1.0.0", kind = "icon" }`).out.error).toBe(
      "ArtifactNotHeld",
    );
    expect(query(GET_ARTIFACT, `{}`).out.error).toBe("ArtifactNotHeld");
  });

  it("serves the bytes of a version deleted at its source", () => {
    const r = query(GET_ARTIFACT, `{ did = "${DID}", name = "probe", version = "1.0.0", kind = "package" }`, {
      setup: `__indexed["${state("probe:1.0.0")}"].record.availability = "deletedAtSource"`,
    });
    expect(r.out).toEqual(blobRef(CIDS.package1, "application/wasm", 40));
  });
});

describe("registry.fetch-changelog after the move", () => {
  it("still caches a document through the shared fetch", () => {
    const source = [
      HARNESS,
      STUBS,
      serveDocument("# Job"),
      CHANGELOG_JOB,
      `local ok, out = pcall(handle, { did = "${DID}", name = "probe", version = "1.0.0", uri = "${DOCUMENT_URI}" }, ${CTX})`,
      `io.write(__encode({ ok = ok, cache = __indexed["${CHANGELOG_URI}"].record }))`,
    ].join("\n\n");
    const result = Bun.spawnSync([lua!, "-"], { stdin: new TextEncoder().encode(source) });
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(parsed.ok).toBe(true);
    expect(parsed.cache.markdown).toBe("# Job");
  });
});

describe("answers validate against the query lexicons", () => {
  // The harness encodes an empty list as {}, so these cases are chosen to
  // have no empty arrays; json.to_array covers the empty case in HappyView.
  const lexicons = new Lexicons();
  const loaded = (async () => {
    const walk = async (dir: string): Promise<string[]> =>
      (await readdir(dir, { withFileTypes: true, recursive: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => join(e.parentPath, e.name));
    for (const file of [...(await walk("lexicons")), ...(await walk("vendor/lexicons"))]) {
      lexicons.add(JSON.parse(await readFile(file, "utf8")));
    }
  })();

  // The fixtures name CIDs readably; each is swapped for a real CID here so
  // the cid format and blob refs can be checked.
  const REAL_CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
  const realCids = (v: any): any => {
    if (typeof v === "string") return /^baf[a-z]+$/.test(v) && v.length < 40 ? REAL_CID : v;
    if (Array.isArray(v)) return v.map(realCids);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, realCids(x)]));
    return v;
  };

  const cases: [string, string, string][] = [
    ["at.happyproto.registry.getProject", GET_PROJECT, `{ actor = "pub.test", name = "probe" }`],
    ["at.happyproto.registry.searchProjects", SEARCH, `{ q = "probe" }`],
    ["at.happyproto.registry.getVersion", GET_VERSION, `{ did = "${DID}", name = "probe", version = "1.1.0-beta.1" }`],
    ["at.happyproto.registry.resolveChannel", RESOLVE, `{ did = "${DID}", name = "probe", channel = "latest" }`],
  ];
  for (const [nsid, script, input] of cases) {
    it(nsid, async () => {
      await loaded;
      const setup = nsid.endsWith("resolveChannel")
        ? `__put("${at(DID, "software.release.status", "3kstatus4")}", "bafys4", { subject = "${VERSION_1}", status = "endOfSupport" })`
        : "";
      const { out } = query(script, input, { setup });
      expect(out.error).toBeUndefined();
      expect(() => lexicons.assertValidXrpcOutput(nsid, jsonToLex(realCids(out)))).not.toThrow();
    });
  }
});
