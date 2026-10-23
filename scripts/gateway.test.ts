/**
 * The registry's gateway procedures, executed. Each writes software.release
 * records into the caller's repo through `happyview.record`, one at a time
 * and in dependency order, so the index scripts accept each record as it
 * arrives. The record library is faked: every write is logged in order,
 * answers a CID derived from its collection, and is mirrored into the index
 * at once, as HappyView's is.
 */
import { describe, expect } from "bun:test";
import { HARNESS } from "./harness";
import { findLua } from "./lua";
import { generated, it } from "./procedure";

const PUT_PROJECT = await generated("src/at/happyproto/registry/putProject.lua");
const PUBLISH = await generated("src/at/happyproto/registry/publishRelease.lua");
const PROMOTE = await generated("src/at/happyproto/registry/promoteRelease.lua");
const PUT_STATUS = await generated("src/at/happyproto/registry/putStatus.lua");
const RETRY = await generated("src/at/happyproto/registry/retryVersion.lua");

const DID = "did:plc:pub";
const EVE = "did:plc:eve";
const HP = "did:plc:hp";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

const at = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
const PROJECT_URI = at(DID, "software.release.project", "probe");
const SIDECAR_URI = at(DID, "at.happyproto.registry.project", "probe");
const PUBLICATION_URI = at(DID, "site.standard.publication", "probe");
const MANIFEST_URI = at(DID, "software.release.manifest", "3kmanifest");
const VERSION_URI = at(DID, "software.release.version", "probe:1.0.0");
const STATUS_URI = at(DID, "software.release.status", "3kstatus");
const PROJECT_STATE_URI = at(HP, "at.happyproto.registry.projectState", `${DID}:probe`);
const STATE_URI = at(HP, "at.happyproto.registry.versionState", `${DID}:probe:1.0.0`);

const blob = (mimeType: string, size: number) =>
  `{ ["$type"] = "blob", ref = { ["$link"] = "${CID}" }, mimeType = "${mimeType}", size = ${size} }`;

/** The artifact probe 1.0.0's manifest carries, with `extra` spliced in. */
const artifact = (extra = "") => `{
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
  ${extra}
}`;

/** The same artifact as a client would send it: keys in another order, no $type. */
const SENT_ARTIFACT = `{
  sections = { description = "Runs Lua." },
  license = "MIT",
  fileExtensions = { "lua" },
  languageId = "lua",
  capabilities = { "library:call" },
  apiVersion = "2",
  pluginType = "interpreter",
  manifest = { size = 456.0, mimeType = "application/json", ref = { ["$link"] = "${CID}" }, ["$type"] = "blob" },
  package = { size = 1234, mimeType = "application/wasm", ref = { ["$link"] = "${CID}" }, ["$type"] = "blob" },
}`;

const sidecar = (pluginType = "interpreter") => `{
  ["$type"] = "at.happyproto.registry.project",
  project = "${PROJECT_URI}",
  publication = { uri = "${PUBLICATION_URI}", cid = "bafypub" },
  pluginType = "${pluginType}",
  authors = { { name = "Trezy" } },
  security = { { email = "security@example.com" } },
}`;

/**
 * The index before each call: `did:plc:pub` has the plugin project probe
 * (project, sidecar, publication) at 1.0.0 with one manifest, and the
 * registry holds probe's cached publication and 1.0.0's state. `did:plc:eve`
 * has a project of her own.
 *
 * `__fail[collection]`, when set, makes the next write to that collection
 * raise with its text, the way the host raises a PDS refusal.
 */
const STUBS = String.raw`
__indexed = {}
local function put(uri, cid, record)
  __indexed[uri] = { uri = uri, cid = cid, record = record, indexed_at = "2026-10-23T00:00:00Z" }
end

put("${PROJECT_URI}", "bafyproject", { ["$type"] = "software.release.project", name = "probe" })
put("${SIDECAR_URI}", "bafysidecar", ${sidecar()})
put("${PUBLICATION_URI}", "bafypub", { ["$type"] = "site.standard.publication", name = "Probe", url = "https://happyproto.at/plugins/${DID}/probe" })
put("${MANIFEST_URI}", "bafymanifest", { ["$type"] = "software.release.manifest", project = "${PROJECT_URI}", artifacts = { ${artifact()} } })
put("${VERSION_URI}", "bafyversion", {
  ["$type"] = "software.release.version", project = "${PROJECT_URI}", version = "1.0.0",
  manifest = { uri = "${MANIFEST_URI}", cid = "bafymanifest" },
})
put("${at(EVE, "software.release.project", "probe")}", "bafyeveproject", { name = "probe" })
put("${at(EVE, "at.happyproto.registry.project", "probe")}", "bafyevesidecar", { pluginType = "interpreter" })
put("${at(EVE, "software.release.version", "probe:1.0.0")}", "bafyeveversion", { version = "1.0.0" })
put("${PROJECT_STATE_URI}", nil, {
  did = "${DID}", name = "probe",
  publication = { uri = "${PUBLICATION_URI}", cid = "bafypub", name = "Probe", url = "https://x" },
})
put("${STATE_URI}", nil, {
  did = "${DID}", name = "probe", version = "1.0.0", uri = "${VERSION_URI}",
  manifestUri = "${MANIFEST_URI}", manifestCid = "bafymanifest", availability = "pending",
})

__fail = {}
__writes = 0

local function mirror(uri, cid, body)
  __indexed[uri] = { uri = uri, cid = cid, record = body }
end

package.preload["happyview.record"] = function()
  return {
    create = function(collection, body, opts)
      local rkey = opts and opts.rkey
      __calls[#__calls + 1] = { fn = "create", collection = collection, rkey = rkey, body = body }
      if __fail[collection] then
        local why = __fail[collection]
        __fail[collection] = nil
        error(why)
      end
      __writes = __writes + 1
      if not rkey then rkey = "tid-" .. __writes end
      local uri = "at://" .. __caller .. "/" .. collection .. "/" .. rkey
      if __indexed[uri] then error("InvalidRequest: Record already exists") end
      local cid = "bafy" .. collection .. __writes
      mirror(uri, cid, body)
      return { uri = uri, cid = cid }
    end,
    put = function(uri, body, opts)
      local collection = uri:match("^at://[^/]+/([^/]+)/")
      __calls[#__calls + 1] = { fn = "put", uri = uri, collection = collection, body = body, opts = opts }
      if __fail[collection] then
        local why = __fail[collection]
        __fail[collection] = nil
        error(why)
      end
      local swap = opts and opts.swap_cid
      if swap ~= nil and (not __indexed[uri] or __indexed[uri].cid ~= swap) then
        error("InvalidSwap: Record was at " .. tostring(__indexed[uri] and __indexed[uri].cid))
      end
      __writes = __writes + 1
      local cid = "bafy" .. collection .. __writes
      mirror(uri, cid, body)
      return { uri = uri, cid = cid }
    end,
  }
end

package.preload["happyview.db"] = function()
  local function parts(uri) return uri:match("^at://([^/]+)/([^/]+)/(.+)$") end
  return {
    get = function(uri) return __indexed[uri] end,
    records = function(collection)
      local q = { filters = {} }
      function q:did(d) self.owner = d; return self end
      function q:where(path, op, value) self.filters[#self.filters + 1] = { path, op, value }; return self end
      function q:sort(field, direction) self.descending = direction == "desc"; return self end
      function q:limit(n) self.max = n; return self end
      function q:cursor() return self end
      function q:run()
        local uris = {}
        for uri in pairs(__indexed) do uris[#uris + 1] = uri end
        table.sort(uris, function(a, b) if self.descending then return a > b end return a < b end)
        local out = {}
        for _, uri in ipairs(uris) do
          local did, c = parts(uri)
          local e = __indexed[uri]
          local keep = c == collection and (self.owner == nil or did == self.owner)
          for _, f in ipairs(self.filters) do
            if f[2] ~= "=" or e.record[f[1]] ~= f[3] then keep = false end
          end
          if keep and (not self.max or #out < self.max) then out[#out + 1] = e end
        end
        return { records = out }
      end
      return q
    end,
  }
end

package.preload["happyview.jobs"] = function()
  return {
    create = function(job_type, input)
      __calls[#__calls + 1] = { fn = "job", job_type = job_type, input = input }
      return "job-1"
    end,
  }
end

package.preload["internal.logging"] = function()
  local function at(level)
    return function(message, fields)
      __calls[#__calls + 1] = { fn = "log", level = level, message = message, fields = fields }
    end
  end
  return { debug = at("debug"), info = at("info"), warn = at("warn"), error = at("error") }
end
`;

const ctxFor = (did: string | null) =>
  did ? `{ caller_did = "${did}", env = { HAPPYPROTO_DID = "${HP}" } }` : `{ env = { HAPPYPROTO_DID = "${HP}" } }`;
const CTX = ctxFor(DID);
const ANONYMOUS = ctxFor(null);

const lua = findLua();

type Result = { out: any; first: any; calls: any[]; indexed: Record<string, any> };

/**
 * Runs one procedure. With `again`, that Lua runs after the first call and
 * the procedure is called a second time with the same input: `first` is the
 * first answer and `out` the second, and the calls of both are logged with
 * an `{fn: "again"}` marker between them.
 */
function call(script: string, input: string, { ctx = CTX, setup = "", again = null as string | null } = {}): Result {
  if (!lua) throw new Error("no lua on PATH, so the procedure was never executed");
  const caller = ctx.match(/caller_did = "([^"]+)"/)?.[1] ?? "nobody";
  const source = [
    HARNESS,
    STUBS,
    `__caller = "${caller}"`,
    setup,
    script,
    `local __input = ${input}`,
    `__first = handle(__input, ${ctx})`,
    again === null
      ? "__out = __first; __first = nil"
      : `${again}\n__calls[#__calls + 1] = { fn = "again" }\n__out = handle(${input}, ${ctx})`,
    "io.write(__encode({ out = __out, first = __first, calls = __calls, indexed = __indexed }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return {
    out: parsed.out ?? null,
    first: parsed.first ?? null,
    calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    indexed: parsed.indexed ?? {},
  };
}

const writes = (calls: any[]) => calls.filter((c) => c.fn === "create" || c.fn === "put");
const order = (calls: any[]) => writes(calls).map((c) => `${c.fn} ${c.collection}`);
const jobs = (calls: any[]) => calls.filter((c) => c.fn === "job");
const logs = (calls: any[]) => calls.filter((c) => c.fn === "log");
const fresh = (...uris: string[]) => uris.map((u) => `__indexed["${u}"] = nil`).join("\n");

/** No project at all yet for probe. */
const NO_PROJECT = fresh(PROJECT_URI, SIDECAR_URI, PUBLICATION_URI, MANIFEST_URI, VERSION_URI, PROJECT_STATE_URI);

const PROJECT_INPUT = (extra = "", project = "") => `{
  name = "probe",
  publication = { name = "Probe", description = "Pokes at things.", icon = ${blob("image/png", 2000)} },
  project = {
    pluginType = "interpreter",
    keywords = { "lua" },
    authors = { { name = "Trezy", url = "https://trezy.com" } },
    security = { { email = "security@example.com" } },
    ${project}
  },
  ${extra}
}`;

describe("common to every gateway procedure", () => {
  const cases: [string, string, string][] = [
    ["putProject", PUT_PROJECT, PROJECT_INPUT()],
    ["publishRelease", PUBLISH, `{ name = "probe", version = "1.1.0", track = "latest", artifact = ${artifact()} }`],
    ["promoteRelease", PROMOTE, `{ name = "probe", fromVersion = "1.0.0", version = "1.1.0" }`],
    ["putStatus", PUT_STATUS, `{ subject = "${VERSION_URI}", status = "endOfSupport" }`],
    ["retryVersion", RETRY, `{ did = "${DID}", name = "probe", version = "1.0.0" }`],
  ];
  for (const [name, script, input] of cases) {
    it(`${name}: NotConfigured without HAPPYPROTO_DID, writing nothing`, () => {
      const r = call(script, input, { ctx: `{ caller_did = "${DID}", env = {} }` });
      expect(r.out.error).toBe("NotConfigured");
      expect(writes(r.calls)).toEqual([]);
    });
    it(`${name}: AuthRequired without a caller, writing nothing`, () => {
      const r = call(script, input, { ctx: ANONYMOUS });
      expect(r.out.error).toBe("AuthRequired");
      expect(writes(r.calls)).toEqual([]);
    });
  }
});

describe("putProject", () => {
  it("first writes the publication, then the sidecar pinning it, then the project", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(), { setup: NO_PROJECT });
    expect(order(r.calls)).toEqual([
      "create site.standard.publication",
      "create at.happyproto.registry.project",
      "create software.release.project",
    ]);
    const [publication, sidecar, project] = writes(r.calls);
    expect(publication.rkey).toBe("probe");
    expect(publication.body).toEqual({
      $type: "site.standard.publication",
      name: "Probe",
      description: "Pokes at things.",
      url: `https://happyproto.at/plugins/${DID}/probe`,
      icon: { $type: "blob", ref: { $link: CID }, mimeType: "image/png", size: 2000 },
    });
    expect(sidecar.rkey).toBe("probe");
    expect(sidecar.body).toEqual({
      $type: "at.happyproto.registry.project",
      project: PROJECT_URI,
      publication: { uri: PUBLICATION_URI, cid: r.out.publication.cid },
      pluginType: "interpreter",
      keywords: ["lua"],
      authors: [{ name: "Trezy", url: "https://trezy.com" }],
      security: [{ email: "security@example.com" }],
    });
    expect(project.rkey).toBe("probe");
    expect(project.body).toEqual({ $type: "software.release.project", name: "probe" });
    expect(r.out).toEqual({
      valid: true,
      created: true,
      publication: { uri: PUBLICATION_URI, cid: "bafysite.standard.publication1" },
      sidecar: { uri: SIDECAR_URI, cid: "bafyat.happyproto.registry.project2" },
      project: { uri: PROJECT_URI, cid: "bafysoftware.release.project3" },
    });
  });

  it("finishes a first call that failed part-way, without creating what exists", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(), {
      setup: NO_PROJECT + `\n__fail["software.release.project"] = "the PDS is down"`,
      again: "",
    });
    expect(r.first.error).toBe("Upstream");
    expect(r.out.created).toBe(true);
    const second = r.calls.slice(r.calls.findIndex((c) => c.fn === "again"));
    expect(order(second)).toEqual([
      "put site.standard.publication",
      "put at.happyproto.registry.project",
      "create software.release.project",
    ]);
  });

  it("later puts the publication, then the sidecar pinning its new CID, swapping on the sidecar's CID", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(`swapCid = "bafysidecar",`));
    expect(order(r.calls)).toEqual(["put site.standard.publication", "put at.happyproto.registry.project"]);
    const [publication, sidecar] = writes(r.calls);
    expect(publication.uri).toBe(PUBLICATION_URI);
    expect(sidecar.uri).toBe(SIDECAR_URI);
    expect(sidecar.opts).toEqual({ swap_cid: "bafysidecar" });
    expect(sidecar.body.publication).toEqual({ uri: PUBLICATION_URI, cid: r.out.publication.cid });
    expect(r.out.created).toBe(false);
    expect(r.out.project).toEqual({ uri: PROJECT_URI, cid: "bafyproject" });
    expect(r.out.sidecar.uri).toBe(SIDECAR_URI);
  });

  it("refuses a stale swapCid before writing anything", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(`swapCid = "bafystale",`));
    expect(r.out.error).toBe("InvalidSwap");
    expect(writes(r.calls)).toEqual([]);
  });

  it("answers InvalidSwap when the PDS refuses the swap", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(`swapCid = "bafysidecar",`), {
      setup: `__fail["at.happyproto.registry.project"] = "XRPC error InvalidSwap: Record was at bafyelse"`,
    });
    expect(r.out.error).toBe("InvalidSwap");
  });

  it("answers Upstream for any other write failure, and logs the reason rather than returning it", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(), { setup: `__fail["site.standard.publication"] = "session secret-token expired"` });
    expect(r.out.error).toBe("Upstream");
    expect(r.out.message).not.toContain("secret-token");
    expect(JSON.stringify(logs(r.calls))).toContain("secret-token");
  });

  it("refuses to change the plugin type", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT("", `pluginType = "library",`).replace(`pluginType = "interpreter",\n`, ""));
    expect(r.out.error).toBe("InvalidRecord");
    expect(r.out.message).toContain("pluginType");
    expect(writes(r.calls)).toEqual([]);
  });

  it("validates anonymously with validateOnly, writing nothing", () => {
    const r = call(PUT_PROJECT, PROJECT_INPUT(`validateOnly = true,`), { ctx: ANONYMOUS });
    expect(r.out).toEqual({ valid: true });
    expect(writes(r.calls)).toEqual([]);
  });

  const refusals: [string, string, string][] = [
    ["a name that is not a project name", `{ name = "Probe", publication = { name = "P" }, project = {} }`, "name"],
    ["an empty display name", PROJECT_INPUT().replace(`name = "Probe"`, `name = ""`), "publication.name"],
    ["a display name over 128 characters", PROJECT_INPUT().replace(`name = "Probe"`, `name = string.rep("a", 129)`), "publication.name"],
    ["a description over 300 characters", PROJECT_INPUT().replace(`"Pokes at things."`, `string.rep("a", 301)`), "publication.description"],
    ["an SVG icon", PROJECT_INPUT().replace(`"image/png", size = 2000`, `"image/svg+xml", size = 2000`), "publication.icon"],
    ["an icon over 1 MB", PROJECT_INPUT().replace(`"image/png", size = 2000`, `"image/png", size = 1000001`), "publication.icon"],
    ["no security contact", PROJECT_INPUT().replace(`security = { { email = "security@example.com" } },`, `security = {},`), "security"],
    ["an unknown plugin type", PROJECT_INPUT().replace(`pluginType = "interpreter"`, `pluginType = "theme"`), "pluginType"],
    ["a javascript author link", PROJECT_INPUT().replace(`"https://trezy.com"`, `"javascript:alert(1)"`), "authors[1].url"],
  ];
  for (const [what, input, field] of refusals) {
    it(`refuses ${what} as InvalidRecord naming ${field}`, () => {
      const r = call(PUT_PROJECT, input, { ctx: ANONYMOUS });
      expect(r.out.error).toBe("InvalidRecord");
      expect(r.out.message).toContain(field);
      expect(writes(r.calls)).toEqual([]);
    });
  }
});

const RELEASE = (extra = "", art = SENT_ARTIFACT) =>
  `{ name = "probe", version = "1.1.0", track = "beta", artifact = ${art}, ${extra} }`;

describe("publishRelease", () => {
  it("writes the manifest, the changelog, the version and the channel, in that order", () => {
    const r = call(PUBLISH, RELEASE(`changelog = "# Fixed"`, artifact(`capabilities = { "library:call", "x" },`)));
    expect(order(r.calls)).toEqual([
      "create software.release.manifest",
      "create site.standard.document",
      "create software.release.version",
      "put software.release.channel",
    ]);
    const [manifest, doc, version, channel] = writes(r.calls);
    expect(manifest.rkey).toBeUndefined();
    expect(manifest.body.project).toBe(PROJECT_URI);
    expect(manifest.body.artifacts).toHaveLength(1);
    expect(manifest.body.artifacts[0].$type).toBe("at.happyproto.plugin.v1");
    expect(doc.rkey).toBeUndefined();
    expect(doc.body).toMatchObject({
      $type: "site.standard.document",
      site: PUBLICATION_URI,
      path: "/changelog/1.1.0",
      title: "Probe 1.1.0",
      textContent: "# Fixed",
      content: {
        $type: "at.markpub.markdown",
        text: { $type: "at.markpub.text", markdown: "# Fixed" },
        flavor: "commonmark",
      },
    });
    expect(doc.body.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(version.rkey).toBe("probe:1.1.0");
    expect(version.body).toEqual({
      $type: "software.release.version",
      project: PROJECT_URI,
      version: "1.1.0",
      manifest: r.out.manifest,
      changelog: r.out.changelog.uri,
    });
    expect(channel.uri).toBe(at(DID, "software.release.channel", "probe:beta"));
    expect(channel.body).toEqual({
      $type: "software.release.channel",
      project: PROJECT_URI,
      name: "beta",
      version: r.out.version,
    });
    expect(r.out.valid).toBe(true);
    expect(r.out.resumed).toBeUndefined();
    expect(r.out.channel.uri).toBe(channel.uri);
  });

  it("writes no document without a changelog, and titles one by the name when no publication is cached", () => {
    const none = call(PUBLISH, RELEASE("", artifact(`license = "Apache-2.0",`)));
    expect(order(none.calls)).not.toContain("create site.standard.document");
    expect(none.out.changelog).toBeUndefined();
    const named = call(PUBLISH, RELEASE(`changelog = "x"`, artifact(`license = "Apache-2.0",`)), { setup: fresh(PROJECT_STATE_URI) });
    expect(writes(named.calls)[1].body.title).toBe("probe 1.1.0");
  });

  it("resumes after the version write failed: no second manifest, resumed = true", () => {
    const r = call(PUBLISH, RELEASE("", artifact(`license = "Apache-2.0",`)), {
      setup: `__fail["software.release.version"] = "the PDS is down"`,
      again: "",
    });
    expect(r.first.error).toBe("Upstream");
    const second = r.calls.slice(r.calls.findIndex((c) => c.fn === "again"));
    // The manifest written by the first call is reused, not written again.
    expect(order(second)).toEqual(["create software.release.version", "put software.release.channel"]);
    expect(r.calls.filter((c) => c.collection === "software.release.manifest")).toHaveLength(1);
    expect(second.find((c) => c.collection === "software.release.version").body.manifest.cid).toBe(
      "bafysoftware.release.manifest1",
    );
  });

  it("resumes after the channel write failed: only the channel is written again", () => {
    const r = call(PUBLISH, RELEASE("", artifact(`license = "Apache-2.0",`)), {
      setup: `__fail["software.release.channel"] = "the PDS is down"`,
      again: "",
    });
    expect(r.first.error).toBe("Upstream");
    const second = r.calls.slice(r.calls.findIndex((c) => c.fn === "again"));
    expect(order(second)).toEqual(["put software.release.channel"]);
    expect(r.out.resumed).toBe(true);
    expect(r.out.version.uri).toBe(at(DID, "software.release.version", "probe:1.1.0"));
    expect(r.out.manifest.cid).toBe("bafysoftware.release.manifest1");
  });

  it("answers every ref on a resume, the changelog's included", () => {
    const r = call(PUBLISH, RELEASE(`changelog = "# Fixed"`, artifact(`license = "Apache-2.0",`)), {
      setup: `__fail["software.release.channel"] = "the PDS is down"`,
      again: "",
    });
    expect(r.out.resumed).toBe(true);
    expect(r.out.manifest.cid).toBe("bafysoftware.release.manifest1");
    expect(r.out.changelog).toEqual({ uri: at(DID, "site.standard.document", "tid-2"), cid: "bafysite.standard.document2" });
    expect(r.out.version.uri).toBe(at(DID, "software.release.version", "probe:1.1.0"));
    expect(r.out.channel.uri).toBe(at(DID, "software.release.channel", "probe:beta"));
  });

  it("resumes an existing version whose manifest carries the same artifact, sent in another key order", () => {
    const r = call(PUBLISH, `{ name = "probe", version = "1.0.0", track = "latest", artifact = ${SENT_ARTIFACT} }`);
    expect(r.out.resumed).toBe(true);
    expect(order(r.calls)).toEqual(["put software.release.channel"]);
    expect(r.out.version).toEqual({ uri: VERSION_URI, cid: "bafyversion" });
    expect(r.out.manifest).toEqual({ uri: MANIFEST_URI, cid: "bafymanifest" });
  });

  it("refuses an existing version with a different artifact as VersionExists", () => {
    const r = call(PUBLISH, `{ name = "probe", version = "1.0.0", track = "latest", artifact = ${artifact(`license = "Apache-2.0",`)} }`);
    expect(r.out.error).toBe("VersionExists");
    expect(writes(r.calls)).toEqual([]);
  });

  it("reuses an identical manifest of the project for a new version", () => {
    const r = call(PUBLISH, RELEASE());
    expect(order(r.calls)).toEqual(["create software.release.version", "put software.release.channel"]);
    expect(r.out.manifest).toEqual({ uri: MANIFEST_URI, cid: "bafymanifest" });
  });

  it("does not reuse a manifest the registry saw rewritten or deleted", () => {
    const r = call(PUBLISH, RELEASE(), {
      setup: `__indexed["${PROJECT_STATE_URI}"].record.suspectManifests = { ["${MANIFEST_URI}"] = true }`,
    });
    expect(order(r.calls)[0]).toBe("create software.release.manifest");
  });

  it("refuses with ProjectMissing without a live sidecar", () => {
    for (const setup of [fresh(SIDECAR_URI), fresh(PROJECT_URI), `__indexed["${PROJECT_STATE_URI}"].record.sidecarDeleted = true`]) {
      const r = call(PUBLISH, RELEASE(), { setup });
      expect(r.out.error).toBe("ProjectMissing");
      expect(writes(r.calls)).toEqual([]);
    }
  });

  it("refuses an artifact of another plugin type than the sidecar's", () => {
    const r = call(PUBLISH, RELEASE("", artifact(`pluginType = "library", namespace = "probe",`)).replace(`pluginType = "interpreter",\n`, ""));
    expect(r.out.error).toBe("InvalidRecord");
    expect(r.out.message).toContain("pluginType");
  });

  it("refuses to move a channel while the project is unavailable or retired", () => {
    const r = call(PUBLISH, RELEASE(), {
      setup: `__indexed["${STATUS_URI}"] = { uri = "${STATUS_URI}", cid = "bafys", indexed_at = "x",
        record = { subject = "${PROJECT_URI}", status = "endOfLife" } }`,
    });
    expect(r.out.error).toBe("NotInstallable");
    expect(writes(r.calls)).toEqual([]);
  });

  it("validates anonymously with validateOnly, writing nothing", () => {
    const r = call(PUBLISH, RELEASE(`validateOnly = true`), { ctx: ANONYMOUS });
    expect(r.out).toEqual({ valid: true });
    expect(writes(r.calls)).toEqual([]);
  });

  it("checks the caller's project with validateOnly when there is a caller", () => {
    const r = call(PUBLISH, RELEASE(`validateOnly = true`), { setup: fresh(SIDECAR_URI) });
    expect(r.out.error).toBe("ProjectMissing");
  });

  const refusals: [string, string, string][] = [
    ["a missing package", artifact().replace(/package = \{[^}]*\}[^}]*\},/, ""), "package"],
    ["an SVG banner", artifact(`banner = { image = ${blob("image/svg+xml", 10)}, width = 1, height = 1 },`), "banner.image"],
    ["a checksum", artifact(`checksum = "sha256:abc",`), "checksum"],
    ["a url", artifact(`url = "https://example.com/probe.wasm",`), "url"],
    ["an oversized package", artifact().replace(`"application/wasm", size = 1234`, `"application/wasm", size = 16777217`), "package"],
    ["apiVersion 1", artifact(`apiVersion = "1",`).replace(`apiVersion = "2",\n`, ""), "apiVersion"],
    ["an interpreter with no language", artifact().replace(`languageId = "lua",`, ""), "languageId"],
  ];
  for (const [what, art, field] of refusals) {
    it(`refuses an artifact with ${what} as InvalidRecord naming the problem`, () => {
      const r = call(PUBLISH, RELEASE("", art), { ctx: ANONYMOUS });
      expect(r.out.error).toBe("InvalidRecord");
      expect(r.out.message).toContain(field);
      expect(writes(r.calls)).toEqual([]);
    });
  }

  for (const [what, input] of [
    ["a version that is not semver", RELEASE().replace(`"1.1.0"`, `"v1.1"`)],
    ["a prerelease with a leading zero", RELEASE().replace(`"1.1.0"`, `"1.1.0-01"`)],
    ["a prerelease identifier with a leading zero", RELEASE().replace(`"1.1.0"`, `"1.1.0-alpha.00"`)],
    ["a track that is not one of the three", RELEASE().replace(`"beta"`, `"nightly"`)],
    ["a changelog over 20000 bytes", RELEASE(`changelog = string.rep("a", 20001)`)],
    ["a name that is not a project name", RELEASE().replace(`name = "probe"`, `name = "Probe"`)],
  ] as const) {
    it(`refuses ${what} as InvalidRecord`, () => {
      const r = call(PUBLISH, input, { ctx: ANONYMOUS });
      expect(r.out.error).toBe("InvalidRecord");
    });
  }
});

const PROMOTE_INPUT = (extra = "") => `{ name = "probe", fromVersion = "1.0.0", version = "1.0.1", ${extra} }`;

describe("promoteRelease", () => {
  it("writes a version pointing at the same manifest strongRef, then the changelog and channel in order", () => {
    const r = call(PROMOTE, PROMOTE_INPUT(`track = "latest", changelog = "Promoted."`));
    expect(order(r.calls)).toEqual([
      "create site.standard.document",
      "create software.release.version",
      "put software.release.channel",
    ]);
    const version = writes(r.calls)[1];
    expect(version.rkey).toBe("probe:1.0.1");
    expect(version.body).toEqual({
      $type: "software.release.version",
      project: PROJECT_URI,
      version: "1.0.1",
      manifest: { uri: MANIFEST_URI, cid: "bafymanifest" },
      changelog: r.out.changelog.uri,
    });
    expect(writes(r.calls)[0].body.path).toBe("/changelog/1.0.1");
    expect(writes(r.calls)[2].body.version).toEqual(r.out.version);
    expect(r.out.channel.uri).toBe(at(DID, "software.release.channel", "probe:latest"));
  });

  it("moves no channel without a track", () => {
    const r = call(PROMOTE, PROMOTE_INPUT());
    expect(order(r.calls)).toEqual(["create software.release.version"]);
    expect(r.out.channel).toBeUndefined();
  });

  it("refuses a new version with a leading zero in a prerelease identifier", () => {
    for (const v of ["1.0.1-01", "1.0.1-rc.00"]) {
      const r = call(PROMOTE, PROMOTE_INPUT().replace(`"1.0.1"`, `"${v}"`));
      expect(r.out.error).toBe("InvalidRecord");
      expect(writes(r.calls)).toEqual([]);
    }
  });

  it("refuses VersionNotFound for a fromVersion that is not the caller's", () => {
    const r = call(PROMOTE, PROMOTE_INPUT().replace(`"1.0.0"`, `"0.9.0"`));
    expect(r.out.error).toBe("VersionNotFound");
    expect(writes(r.calls)).toEqual([]);
  });

  it("refuses VersionExists for a version already published on another manifest", () => {
    const r = call(PROMOTE, PROMOTE_INPUT(), {
      setup: `__indexed["${at(DID, "software.release.version", "probe:1.0.1")}"] = { uri = "x", cid = "bafyx", indexed_at = "x",
        record = { version = "1.0.1", manifest = { uri = "${at(DID, "software.release.manifest", "3kother")}", cid = "bafyother" } } }`,
    });
    expect(r.out.error).toBe("VersionExists");
    expect(writes(r.calls)).toEqual([]);
  });

  it("finishes a promotion whose channel write failed", () => {
    const r = call(PROMOTE, PROMOTE_INPUT(`track = "latest"`), {
      setup: `__fail["software.release.channel"] = "the PDS is down"`,
      again: "",
    });
    expect(r.first.error).toBe("Upstream");
    const second = r.calls.slice(r.calls.findIndex((c) => c.fn === "again"));
    expect(order(second)).toEqual(["put software.release.channel"]);
    expect(r.out.version.uri).toBe(at(DID, "software.release.version", "probe:1.0.1"));
  });

  it("refuses NotInstallable when moving a channel while the project is unavailable", () => {
    const r = call(PROMOTE, PROMOTE_INPUT(`track = "latest"`), {
      setup: `__indexed["${STATUS_URI}"] = { uri = "${STATUS_URI}", cid = "bafys", indexed_at = "x",
        record = { subject = "${PROJECT_URI}", status = "endOfDistribution" } }`,
    });
    expect(r.out.error).toBe("NotInstallable");
    expect(writes(r.calls)).toEqual([]);
  });

  it("refuses ProjectMissing without a live sidecar", () => {
    const r = call(PROMOTE, PROMOTE_INPUT(), { setup: fresh(SIDECAR_URI) });
    expect(r.out.error).toBe("ProjectMissing");
  });
});

describe("putStatus", () => {
  it("writes a status about the caller's version with a TID key", () => {
    const r = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "endOfSupport", kind = "security", reason = "CVE" }`);
    expect(order(r.calls)).toEqual(["create software.release.status"]);
    const [status] = writes(r.calls);
    expect(status.rkey).toBeUndefined();
    expect(status.body).toEqual({
      $type: "software.release.status",
      subject: VERSION_URI,
      status: "endOfSupport",
      kind: "security",
      reason: "CVE",
    });
    expect(r.out).toEqual({ uri: at(DID, "software.release.status", "tid-1"), cid: "bafysoftware.release.status1" });
  });

  it("writes a status about the caller's project", () => {
    const r = call(PUT_STATUS, `{ subject = "${PROJECT_URI}", status = "endOfLife" }`);
    expect(r.out.uri).toBeDefined();
  });

  it("refuses a subject of another DID as SubjectNotFound", () => {
    const r = call(PUT_STATUS, `{ subject = "${at(EVE, "software.release.version", "probe:1.0.0")}", status = "endOfLife" }`);
    expect(r.out.error).toBe("SubjectNotFound");
    expect(writes(r.calls)).toEqual([]);
  });

  it("refuses a subject that is not stored, or not a version or project", () => {
    for (const subject of [at(DID, "software.release.version", "probe:2.0.0"), MANIFEST_URI, "https://example.com"]) {
      const r = call(PUT_STATUS, `{ subject = "${subject}", status = "endOfLife" }`);
      expect(r.out.error).toBe("SubjectNotFound");
    }
  });

  it("refuses a subject whose project has no live sidecar", () => {
    const r = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "endOfLife" }`, { setup: fresh(SIDECAR_URI) });
    expect(r.out.error).toBe("SubjectNotFound");
  });

  it("requires a non-empty status of at most 64 characters", () => {
    for (const status of [`""`, `string.rep("a", 65)`, `7`]) {
      const r = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = ${status} }`);
      expect(r.out.error).toBe("InvalidStatus");
    }
  });

  it("requires supersededBy, a version, when the status is supersededBy", () => {
    expect(call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "supersededBy" }`).out.error).toBe("InvalidStatus");
    expect(call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "supersededBy", supersededBy = "v2" }`).out.error).toBe(
      "InvalidStatus",
    );
    const r = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "supersededBy", supersededBy = "1.1.0" }`);
    expect(writes(r.calls)[0].body.supersededBy).toBe("1.1.0");
  });

  const STORED_STATUS = `__indexed["${STATUS_URI}"] = { uri = "${STATUS_URI}", cid = "bafys", indexed_at = "x",
    record = { subject = "${VERSION_URI}", status = "endOfSupport" } }`;

  it("requires withdraws, a stored status of the caller, when the status is withdrawn", () => {
    expect(call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "withdrawn" }`).out.error).toBe("InvalidStatus");
    const missing = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "withdrawn", withdraws = "${STATUS_URI}" }`);
    expect(missing.out.error).toBe("SubjectNotFound");
    const eves = at(EVE, "software.release.status", "3keve");
    const forged = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "withdrawn", withdraws = "${eves}" }`, {
      setup: `__indexed["${eves}"] = { uri = "${eves}", cid = "bafye", indexed_at = "x", record = { subject = "${VERSION_URI}", status = "endOfLife" } }`,
    });
    expect(forged.out.error).toBe("SubjectNotFound");
    const r = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "withdrawn", withdraws = "${STATUS_URI}", reason = "mistake" }`, {
      setup: STORED_STATUS,
    });
    expect(writes(r.calls)[0].body.withdraws).toBe(STATUS_URI);
  });

  it("refuses a withdrawal of a status about another subject", () => {
    const r = call(PUT_STATUS, `{ subject = "${PROJECT_URI}", status = "withdrawn", withdraws = "${STATUS_URI}" }`, {
      setup: STORED_STATUS,
    });
    expect(r.out.error).toBe("InvalidStatus");
    expect(writes(r.calls)).toEqual([]);
  });

  it("refuses a reason over 300 characters or a kind over 64 as InvalidRecord", () => {
    for (const extra of [`reason = string.rep("a", 301)`, `kind = string.rep("a", 65)`]) {
      const r = call(PUT_STATUS, `{ subject = "${VERSION_URI}", status = "endOfLife", ${extra} }`);
      expect(r.out.error).toBe("InvalidRecord");
    }
  });
});

describe("retryVersion", () => {
  const INPUT = `{ did = "${DID}", name = "probe", version = "1.0.0" }`;

  it("is forbidden to anyone but the registry's own account", () => {
    const r = call(RETRY, INPUT);
    expect(r.out.error).toBe("Forbidden");
    expect(jobs(r.calls)).toEqual([]);
  });

  it("enqueues the copy again for a pending version and answers its availability", () => {
    const r = call(RETRY, INPUT, { ctx: ctxFor(HP) });
    expect(jobs(r.calls)).toEqual([
      { fn: "job", job_type: "registry.copy-version", input: { did: DID, name: "probe", version: "1.0.0" } },
    ]);
    expect(r.out).toEqual({ availability: "pending" });
  });

  it("enqueues nothing for a version whose blobs are held or deleted at source", () => {
    for (const availability of ["available", "deletedAtSource"]) {
      const r = call(RETRY, INPUT, {
        ctx: ctxFor(HP),
        setup: `__indexed["${STATE_URI}"].record.availability = "${availability}"`,
      });
      expect(jobs(r.calls)).toEqual([]);
      expect(r.out).toEqual({ availability });
    }
  });

  it("answers VersionNotFound without a version state", () => {
    const r = call(RETRY, INPUT.replace(`"1.0.0"`, `"2.0.0"`), { ctx: ctxFor(HP) });
    expect(r.out.error).toBe("VersionNotFound");
  });

  it("refuses an input that names no version as InvalidRecord", () => {
    const r = call(RETRY, `{ did = "nobody", name = "probe", version = "1.0.0" }`, { ctx: ctxFor(HP) });
    expect(r.out.error).toBe("InvalidRecord");
  });
});
