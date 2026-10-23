/**
 * The registry's jobs, executed against an index held in a Lua table and a
 * publisher's PDS faked through `__reply`. Each case runs one job and reads
 * back whether it raised, what it answered, and what it asked HappyView to
 * do: HTTP requests, blob writes, local state writes and log lines.
 */
import { describe, expect } from "bun:test";
import { HARNESS } from "./harness";
import { findLua } from "./lua";
import { generated, it } from "./procedure";

const COPY = await generated("jobs/registry.copy-version.lua");
const PUBLICATION = await generated("jobs/registry.fetch-publication.lua");
const CHANGELOG = await generated("jobs/registry.fetch-changelog.lua");

const DID = "did:plc:pub";
const HP = "did:plc:hp";
const PDS = "http://pds.test";
const ENCODED_DID = "did%3Aplc%3Apub";

const at = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
const MANIFEST_URI = at(DID, "software.release.manifest", "3kmanifest");
const VERSION_URI = at(DID, "software.release.version", "probe:1.0.0");
const SIDECAR_URI = at(DID, "at.happyproto.registry.project", "probe");
const PUBLICATION_URI = at(DID, "site.standard.publication", "probe");
const DOCUMENT_URI = at(DID, "site.standard.document", "3kchangelog");
const STATE_URI = at(HP, "at.happyproto.registry.versionState", `${DID}:probe:1.0.0`);
const PROJECT_STATE_URI = at(HP, "at.happyproto.registry.projectState", `${DID}:probe`);
const CHANGELOG_URI = at(HP, "at.happyproto.registry.changelogCache", `${DID}:probe:1.0.0`);

const CIDS = {
  package: "bafkreipackage",
  manifest: "bafkreimanifest",
  banner: "bafkreibanner",
  shot: "bafkreishot",
  icon: "bafkreiicon",
};

const blobUrl = (cid: string) =>
  `${PDS}/xrpc/com.atproto.sync.getBlob?did=${ENCODED_DID}&cid=${cid}`;
const recordUrl = (collection: string, rkey: string) =>
  `${PDS}/xrpc/com.atproto.repo.getRecord?repo=${ENCODED_DID}&collection=${collection}&rkey=${rkey}`;

const blob = (cid: string, mimeType: string, size: number) =>
  `{ ["$type"] = "blob", ref = { ["$link"] = "${cid}" }, mimeType = "${mimeType}", size = ${size} }`;

const ARTIFACT = `{
  ["$type"] = "at.happyproto.plugin.v1",
  package = ${blob(CIDS.package, "application/wasm", 4)},
  manifest = ${blob(CIDS.manifest, "application/json", 2)},
  banner = { image = ${blob(CIDS.banner, "image/png", 6)}, width = 1200, height = 400 },
  screenshots = { { image = ${blob(CIDS.shot, "image/webp", 4)}, width = 1280, height = 720 } },
  pluginType = "interpreter",
  apiVersion = "2",
  capabilities = { "library:call" },
  languageId = "lua",
  fileExtensions = { "lua" },
  license = "MIT",
  sections = { description = "Runs Lua." },
}`;

/**
 * The index, the publisher's PDS and the blob store before each job.
 *
 * `__pds[url]` is the PDS's answer to a GET: a table `{status, body}`, or a
 * list of them answered in turn (the last one repeats). `__hash[body]` is the
 * CID a body hashes to; a `$bytes` body is looked up by its base64. Bytes the
 * test didn't name hash to `bafkreiunknown`.
 */
const STUBS = String.raw`
__indexed = {}
local function put(uri, cid, record) __indexed[uri] = { uri = uri, cid = cid, record = record } end

put("${SIDECAR_URI}", "bafysidecar", {
  ["$type"] = "at.happyproto.registry.project",
  project = "${at(DID, "software.release.project", "probe")}",
  publication = { uri = "${PUBLICATION_URI}", cid = "bafypub" },
  pluginType = "interpreter",
  authors = { { name = "Trezy" } },
  security = { { email = "security@example.com" } },
})
put("${MANIFEST_URI}", "bafymanifestrecord", {
  ["$type"] = "software.release.manifest",
  project = "${at(DID, "software.release.project", "probe")}",
  artifacts = { ${ARTIFACT} },
})
put("${STATE_URI}", nil, {
  did = "${DID}", name = "probe", version = "1.0.0", uri = "${VERSION_URI}",
  manifestUri = "${MANIFEST_URI}", manifestCid = "bafymanifestrecord",
  availability = "pending", suspect = false,
})

__pds = {
  ["${blobUrl(CIDS.package)}"] = { status = 200, body = { ["$bytes"] = "AGFzbQ" } },
  ["${blobUrl(CIDS.manifest)}"] = { status = 200, body = "{}" },
  ["${blobUrl(CIDS.banner)}"] = { status = 200, body = { ["$bytes"] = "iVBORw0K" } },
  ["${blobUrl(CIDS.shot)}"] = { status = 200, body = { ["$bytes"] = "UklGRg" } },
  ["${blobUrl(CIDS.icon)}"] = { status = 200, body = { ["$bytes"] = "iVBORw" } },
}
__hash = {
  AGFzbQ = "${CIDS.package}",
  ["{}"] = "${CIDS.manifest}",
  iVBORw0K = "${CIDS.banner}",
  UklGRg = "${CIDS.shot}",
  iVBORw = "${CIDS.icon}",
}
__served = {}
__reply = function(method, url)
  local answer = __pds[url]
  if answer == nil then return { status = 404, body = "" } end
  if answer[1] ~= nil then
    __served[url] = (__served[url] or 0) + 1
    return answer[math.min(__served[url], #answer)]
  end
  return answer
end

package.preload["happyview.atproto"] = function()
  return {
    resolve_service_endpoint = function(did)
      __calls[#__calls + 1] = { fn = "resolve", did = did }
      if did == "${DID}" then return "${PDS}" end
      return nil
    end,
  }
end

package.preload["happyview.blobs"] = function()
  return {
    put = function(bytes, mime)
      local key = type(bytes) == "table" and bytes["$bytes"] or bytes
      __calls[#__calls + 1] = { fn = "blobs.put", mime = mime, key = #key <= 64 and key or "<long>" }
      return __hash[key] or "bafkreiunknown"
    end,
    stat = function(cid)
      return nil
    end,
  }
end

package.preload["happyview.db"] = function()
  return { get = function(uri) return __indexed[uri] end }
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

const lua = findLua();

type Result = { ok: boolean; error: string | null; out: any; calls: any[]; state: any };

/**
 * Runs one job. Unlike the procedure harness this catches a raise, because a
 * job that raises is retried and what it wrote before raising is the point.
 * `state` is the final value of one stored row, read back after the run.
 */
function job(script: string, input: string, { setup = "", ctx = CTX, read = STATE_URI } = {}): Result {
  if (!lua) throw new Error("no lua on PATH, so the job was never executed");
  const source = [
    HARNESS,
    STUBS,
    setup,
    script,
    `local __ok, __out = pcall(handle, ${input}, ${ctx})`,
    `local __row = __indexed["${read}"]`,
    "io.write(__encode({ ok = __ok, error = (not __ok) and tostring(__out) or nil, out = __ok and __out or nil,",
    "  calls = __calls, state = __row and __row.record or nil }))",
  ].join("\n\n");
  const result = Bun.spawnSync([lua, "-"], { stdin: new TextEncoder().encode(source) });
  if (result.exitCode !== 0) {
    throw new Error(`lua exited ${result.exitCode}:\n${new TextDecoder().decode(result.stderr)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  return {
    ok: parsed.ok,
    error: parsed.error ?? null,
    out: parsed.out ?? null,
    calls: Array.isArray(parsed.calls) ? parsed.calls : [],
    state: parsed.state ?? null,
  };
}

const gets = (calls: any[]) => calls.filter((c) => c.fn === "get").map((c) => c.url);
const puts = (calls: any[]) => calls.filter((c) => c.fn === "blobs.put");
const writes = (calls: any[]) => calls.filter((c) => c.fn === "save_local");
const logs = (calls: any[]) => calls.filter((c) => c.fn === "log");

const COPY_INPUT = `{ did = "${DID}", name = "probe", version = "1.0.0" }`;
const copy = (setup = "") => job(COPY, COPY_INPUT, { setup });
const setState = (lua: string) => `for k, v in pairs(${lua}) do __indexed["${STATE_URI}"].record[k] = v end`;
const serve = (cid: string, answer: string) => `__pds["${blobUrl(cid)}"] = ${answer}`;

describe("registry.copy-version", () => {
  it("raises without HAPPYPROTO_DID", () => {
    const r = job(COPY, COPY_INPUT, { ctx: "{ env = {} }" });
    expect(r.ok).toBe(false);
    expect(writes(r.calls)).toHaveLength(0);
  });

  it("copies every blob and makes the version available", () => {
    const r = copy();
    expect(r.ok).toBe(true);
    expect(r.state.availability).toBe("available");
    expect(r.state.suspect).toBe(false);
    expect(r.state.held).toEqual({
      package: { cid: CIDS.package, mimeType: "application/wasm", size: 4 },
      manifest: { cid: CIDS.manifest, mimeType: "application/json", size: 2 },
      banner: { cid: CIDS.banner, mimeType: "image/png", size: 6 },
      "screenshot.1": { cid: CIDS.shot, mimeType: "image/webp", size: 4 },
    });
    // The state row's other fields survive the write.
    expect(r.state.manifestUri).toBe(MANIFEST_URI);
    expect(r.state.uri).toBe(VERSION_URI);
  });

  it("fetches each blob from the publisher's PDS by an encoded did and cid", () => {
    const r = copy();
    expect(gets(r.calls).sort()).toEqual(
      [CIDS.package, CIDS.manifest, CIDS.banner, CIDS.shot].map(blobUrl).sort(),
    );
  });

  it("stores bytes under a neutral type, never the publisher's claim", () => {
    // The store keeps a CID's first type for good, so bytes that turn out not
    // to be what was declared must not leave the declared type behind.
    const r = copy();
    for (const p of puts(r.calls)) expect(p.mime).toBe("application/octet-stream");
  });

  it("keeps the version pending and raises when the package hashes to another CID", () => {
    const r = copy(serve(CIDS.package, `{ status = 200, body = "not the package" }`));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("package");
    expect(r.state.availability).toBe("pending");
    expect(r.state.held?.package).toBeUndefined();
    expect(r.state.failed.package).toContain(CIDS.package);
    // What did verify is kept, so a retry need not fetch it again.
    expect(r.state.held.manifest.cid).toBe(CIDS.manifest);
  });

  it("keeps the version pending and raises when the manifest hashes to another CID", () => {
    const r = copy(serve(CIDS.manifest, `{ status = 200, body = "[]" }`));
    expect(r.ok).toBe(false);
    expect(r.state.availability).toBe("pending");
    expect(r.state.held.manifest).toBeUndefined();
    expect(r.state.failed.manifest).toBeDefined();
  });

  it("does not retry a CID mismatch: the same bytes would come back", () => {
    const r = copy(serve(CIDS.package, `{ status = 200, body = "not the package" }`));
    expect(gets(r.calls).filter((u) => u === blobUrl(CIDS.package))).toHaveLength(1);
  });

  it("refuses a package larger than 16 MiB by its real length, whatever the record claims", () => {
    const r = copy(
      serve(CIDS.package, `{ status = 200, body = string.rep("a", 16777217) }`) +
        `\n__hash[string.rep("a", 16777217)] = "${CIDS.package}"`,
    );
    expect(r.ok).toBe(false);
    expect(r.state.availability).toBe("pending");
    expect(r.state.failed.package).toContain("larger than");
    expect(puts(r.calls).filter((p) => p.key === "<long>")).toHaveLength(0);
  });

  it("refuses a manifest larger than 1 MB by its real length", () => {
    const r = copy(
      serve(CIDS.manifest, `{ status = 200, body = string.rep("a", 1000001) }`) +
        `\n__hash[string.rep("a", 1000001)] = "${CIDS.manifest}"`,
    );
    expect(r.ok).toBe(false);
    expect(r.state.held.manifest).toBeUndefined();
    expect(r.state.failed.manifest).toContain("larger than");
  });

  it("measures a $bytes body by its decoded length", () => {
    // 1333332 base64 'A's decode to 999999 bytes, under the 1 MB image
    // limit; 1333336 decode to 1000002, over it.
    const ok = copy(
      serve(CIDS.banner, `{ status = 200, body = { ["$bytes"] = string.rep("A", 1333332) } }`) +
        `\n__hash[string.rep("A", 1333332)] = "${CIDS.banner}"`,
    );
    expect(ok.state.held.banner.size).toBe(999999);
    const over = copy(
      serve(CIDS.banner, `{ status = 200, body = { ["$bytes"] = string.rep("A", 1333336) } }`) +
        `\n__hash[string.rep("A", 1333336)] = "${CIDS.banner}"`,
    );
    expect(over.state.held.banner).toBeUndefined();
    expect(over.state.failed.banner).toContain("larger than");
  });

  it("an image that fails is recorded and the version is still available", () => {
    const r = copy(serve(CIDS.banner, `{ status = 200, body = "a different picture" }`));
    expect(r.ok).toBe(true);
    expect(r.state.availability).toBe("available");
    expect(r.state.held.banner).toBeUndefined();
    expect(r.state.failed.banner).toBeDefined();
    expect(r.state.held["screenshot.1"].cid).toBe(CIDS.shot);
    expect(logs(r.calls).some((l) => l.level === "warn")).toBe(true);
  });

  it("does not fetch a blob it already holds", () => {
    const r = copy(
      setState(`{ held = { package = { cid = "${CIDS.package}", mimeType = "application/wasm", size = 4 } } }`),
    );
    expect(gets(r.calls)).not.toContain(blobUrl(CIDS.package));
    expect(r.state.availability).toBe("available");
    expect(r.state.held.package.cid).toBe(CIDS.package);
  });

  it("refetches a held entry whose CID is not the declared one", () => {
    const r = copy(setState(`{ held = { package = { cid = "bafkreistale", mimeType = "application/wasm", size = 4 } } }`));
    expect(gets(r.calls)).toContain(blobUrl(CIDS.package));
    expect(r.state.held.package.cid).toBe(CIDS.package);
  });

  it("clears a recorded failure once the blob verifies", () => {
    const r = copy(setState(`{ failed = { package = "earlier" } }`));
    expect(r.state.failed?.package).toBeUndefined();
    expect(r.state.availability).toBe("available");
  });

  it("tries a failing fetch up to three times within the run", () => {
    const r = copy(
      serve(CIDS.package, `{ { status = 502, body = "" }, { status = 500, body = "" }, { status = 200, body = { ["$bytes"] = "AGFzbQ" } } }`),
    );
    expect(r.ok).toBe(true);
    expect(gets(r.calls).filter((u) => u === blobUrl(CIDS.package))).toHaveLength(3);
    expect(r.state.availability).toBe("available");
  });

  it("gives up after three failed fetches and raises", () => {
    const r = copy(serve(CIDS.package, `{ status = 503, body = "" }`));
    expect(r.ok).toBe(false);
    expect(gets(r.calls).filter((u) => u === blobUrl(CIDS.package))).toHaveLength(3);
    expect(r.state.availability).toBe("pending");
    expect(r.state.failed.package).toContain("503");
  });

  it("survives an http call that raises", () => {
    const r = copy(`local real = __reply
__reply = function(m, url) if url == "${blobUrl(CIDS.banner)}" then error("connection refused") end return real(m, url) end`);
    expect(r.ok).toBe(true);
    expect(r.state.failed.banner).toContain("connection refused");
  });

  it("raises when the publisher's PDS cannot be resolved", () => {
    const r = copy(`package.loaded["happyview.atproto"] = { resolve_service_endpoint = function() return nil end }`);
    expect(r.ok).toBe(false);
    expect(r.state.availability).toBe("pending");
  });

  it("never makes a version deleted at its source available", () => {
    const r = copy(setState(`{ availability = "deletedAtSource" }`));
    expect(r.state.availability).toBe("deletedAtSource");
  });

  it("never clears suspect", () => {
    const r = copy(setState(`{ suspect = true }`));
    expect(r.state.suspect).toBe(true);
    expect(r.state.availability).toBe("available");
  });

  it("keeps a mark the indexer wrote while the blobs were being fetched", () => {
    // The fetches take time; a manifest rewrite or delete indexed meanwhile
    // must survive this job's write.
    const r = copy(`local real = __reply
__reply = function(m, url)
  local row = __indexed["${STATE_URI}"].record
  __indexed["${STATE_URI}"] = { uri = "${STATE_URI}", record = {
    did = row.did, name = row.name, version = row.version, uri = row.uri,
    manifestUri = row.manifestUri, manifestCid = row.manifestCid,
    availability = "deletedAtSource", suspect = true, held = row.held } }
  return real(m, url)
end`);
    expect(r.state.availability).toBe("deletedAtSource");
    expect(r.state.suspect).toBe(true);
  });

  it("raises when there is no state row", () => {
    const r = copy(`__indexed["${STATE_URI}"] = nil`);
    expect(r.ok).toBe(false);
    expect(gets(r.calls)).toHaveLength(0);
  });

  it("fetches nothing for a version already deleted at its source", () => {
    // The bytes can never make it available, so asking the PDS for them is
    // work for nothing.
    const r = copy(setState(`{ availability = "deletedAtSource" }`));
    expect(r.ok).toBe(true);
    expect(gets(r.calls)).toHaveLength(0);
    expect(puts(r.calls)).toHaveLength(0);
    expect(writes(r.calls)).toHaveLength(0);
    expect(r.state.availability).toBe("deletedAtSource");
  });

  it("asks an unresolvable PDS once per blob, not once per attempt", () => {
    // Resolution failing again a moment later is not a transport hiccup; the
    // job's own retry is the one that should try again.
    const r = copy(`package.loaded["happyview.atproto"] = { resolve_service_endpoint = function(did)
  __calls[#__calls + 1] = { fn = "resolve", did = did }
  return nil
end }`);
    expect(r.ok).toBe(false);
    expect(r.calls.filter((c) => c.fn === "resolve")).toHaveLength(4);
  });

  it("refuses a PDS endpoint that is not an http or https URL", () => {
    for (const endpoint of ["javascript:alert(1)", "file:///etc/passwd", "pds.test"]) {
      const r = copy(`package.loaded["happyview.atproto"] = { resolve_service_endpoint = function() return "${endpoint}" end }`);
      expect(r.ok).toBe(false);
      expect(gets(r.calls)).toHaveLength(0);
      expect(r.state.failed.package).toContain("could not be resolved");
    }
  });

  it("writes nothing when the version's manifest changed while the blobs were fetched", () => {
    // A version re-created against another manifest meanwhile: what was
    // copied is not that manifest's, and merging it would vouch for it.
    const r = copy(`local real = __reply
__reply = function(m, url)
  __indexed["${STATE_URI}"].record.manifestCid = "bafyanother"
  return real(m, url)
end`);
    expect(r.ok).toBe(false);
    expect(writes(r.calls)).toHaveLength(0);
    expect(r.state.held).toBeUndefined();
    expect(r.state.availability).toBe("pending");
  });

  it("copies nothing when the stored manifest is not the one the version pinned", () => {
    const r = copy(setState(`{ manifestCid = "bafyelse" }`));
    expect(r.ok).toBe(false);
    expect(gets(r.calls)).toHaveLength(0);
    expect(r.state.availability).toBe("pending");
  });
});

const publicationRecord = (cid = "bafypub", value = "") => `{
  uri = "${PUBLICATION_URI}", cid = "${cid}",
  value = {
    ["$type"] = "site.standard.publication",
    name = "Probe",
    url = "https://happyproto.at/plugins/${DID}/probe",
    description = "A probe.",
    icon = ${blob(CIDS.icon, "image/png", 4)},
    ${value}
  },
}`;
const servePublication = (body: string) =>
  `__pds["${recordUrl("site.standard.publication", "probe")}"] = { status = 200, body = "PUB" }
__decoded["PUB"] = ${body}`;
const PUBLICATION_INPUT = `{ did = "${DID}", name = "probe", uri = "${PUBLICATION_URI}", cid = "bafypub" }`;
const fetchPublication = (setup = "") =>
  job(PUBLICATION, PUBLICATION_INPUT, { setup: servePublication(publicationRecord()) + "\n" + setup, read: PROJECT_STATE_URI });

describe("registry.fetch-publication", () => {
  it("raises without HAPPYPROTO_DID", () => {
    const r = job(PUBLICATION, PUBLICATION_INPUT, { ctx: "{ env = {} }", read: PROJECT_STATE_URI });
    expect(r.ok).toBe(false);
  });

  it("caches the publication the sidecar pins, with its icon copied", () => {
    const r = fetchPublication();
    expect(r.ok).toBe(true);
    expect(gets(r.calls)).toContain(recordUrl("site.standard.publication", "probe"));
    expect(r.state.did).toBe(DID);
    expect(r.state.name).toBe("probe");
    expect(r.state.publication).toEqual({
      uri: PUBLICATION_URI,
      cid: "bafypub",
      name: "Probe",
      description: "A probe.",
      url: `https://happyproto.at/plugins/${DID}/probe`,
      icon: CIDS.icon,
      iconMimeType: "image/png",
    });
    expect(r.state.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(gets(r.calls)).toContain(blobUrl(CIDS.icon));
  });

  it("writes nothing when the PDS answers a CID other than the sidecar's pin", () => {
    const r = job(PUBLICATION, PUBLICATION_INPUT, {
      setup: servePublication(publicationRecord("bafynewer")),
      read: PROJECT_STATE_URI,
    });
    expect(writes(r.calls)).toHaveLength(0);
    expect(r.state).toBeNull();
    expect(logs(r.calls).length).toBeGreaterThan(0);
  });

  it("checks the sidecar's current pin, not the CID the job was given", () => {
    // The sidecar moved on to a newer publication after this job was queued;
    // what this job fetched is the newer one, and it is what the sidecar pins.
    const r = job(PUBLICATION, `{ did = "${DID}", name = "probe", uri = "${PUBLICATION_URI}", cid = "bafyolder" }`, {
      setup: servePublication(publicationRecord()),
      read: PROJECT_STATE_URI,
    });
    expect(r.state.publication.cid).toBe("bafypub");
  });

  it("does nothing once the sidecar is deleted", () => {
    const r = fetchPublication(`__indexed["${SIDECAR_URI}"] = nil`);
    expect(writes(r.calls)).toHaveLength(0);
    expect(gets(r.calls)).toHaveLength(0);
  });

  it("keeps the fields other writers own on projectState", () => {
    const r = fetchPublication(`__indexed["${PROJECT_STATE_URI}"] = { uri = "${PROJECT_STATE_URI}", record = {
      did = "${DID}", name = "probe",
      suspectManifests = { ["${MANIFEST_URI}"] = true },
      deletedManifests = { ["x"] = true },
      publication = { uri = "old", cid = "bafyold", name = "Old", url = "https://old" },
    } }`);
    expect(r.state.suspectManifests).toEqual({ [MANIFEST_URI]: true });
    expect(r.state.deletedManifests).toEqual({ x: true });
    expect(r.state.publication.cid).toBe("bafypub");
  });

  it("keeps sidecarDeleted unchanged", () => {
    // A marked sidecar means no live sidecar, so nothing is fetched at all.
    const r = fetchPublication(`__indexed["${PROJECT_STATE_URI}"] = { uri = "${PROJECT_STATE_URI}", record = {
      did = "${DID}", name = "probe", sidecarDeleted = true } }`);
    expect(writes(r.calls)).toHaveLength(0);
    expect(r.state.sidecarDeleted).toBe(true);
  });

  it("omits an icon whose bytes hash to another CID", () => {
    const r = fetchPublication(serve(CIDS.icon, `{ status = 200, body = "not an icon" }`));
    expect(r.ok).toBe(true);
    expect(r.state.publication.icon).toBeUndefined();
    expect(r.state.publication.iconMimeType).toBeUndefined();
    expect(r.state.publication.name).toBe("Probe");
  });

  it("omits an icon larger than 1 MB by its real length", () => {
    const r = fetchPublication(
      serve(CIDS.icon, `{ status = 200, body = string.rep("a", 1000001) }`) +
        `\n__hash[string.rep("a", 1000001)] = "${CIDS.icon}"`,
    );
    expect(r.state.publication.icon).toBeUndefined();
  });

  it("does not refetch an icon already cached for the same CID", () => {
    const r = fetchPublication(`__indexed["${PROJECT_STATE_URI}"] = { uri = "${PROJECT_STATE_URI}", record = {
      did = "${DID}", name = "probe",
      publication = { uri = "${PUBLICATION_URI}", cid = "bafyold", name = "Old", url = "https://old", icon = "${CIDS.icon}", iconMimeType = "image/png" },
    } }`);
    expect(gets(r.calls)).not.toContain(blobUrl(CIDS.icon));
    expect(r.state.publication.icon).toBe(CIDS.icon);
    expect(r.state.publication.iconMimeType).toBe("image/png");
  });

  it("caches a publication with no icon", () => {
    const r = job(PUBLICATION, PUBLICATION_INPUT, {
      setup: servePublication(publicationRecord("bafypub", "icon = false,")) + `\n__decoded["PUB"].value.icon = nil`,
      read: PROJECT_STATE_URI,
    });
    expect(r.state.publication.icon).toBeUndefined();
    expect(r.state.publication.name).toBe("Probe");
  });

  it("refuses a publication with no name or a url that is not a web link", () => {
    for (const value of [`name = 7,`, `url = "javascript:alert(1)",`]) {
      const r = job(PUBLICATION, PUBLICATION_INPUT, {
        setup: servePublication(publicationRecord("bafypub", value)),
        read: PROJECT_STATE_URI,
      });
      expect(writes(r.calls)).toHaveLength(0);
    }
  });

  it("refuses a url over 2048 bytes or with no host", () => {
    for (const value of [`url = "https://x/" .. string.rep("a", 2039),`, `url = "https://?q",`]) {
      const r = job(PUBLICATION, PUBLICATION_INPUT, {
        setup: servePublication(publicationRecord("bafypub", value)),
        read: PROJECT_STATE_URI,
      });
      expect(r.ok).toBe(true);
      expect(writes(r.calls)).toHaveLength(0);
    }
  });

  it("caches the uri the sidecar pins, not the one the PDS answered", () => {
    const r = job(PUBLICATION, PUBLICATION_INPUT, {
      setup:
        servePublication(publicationRecord()) +
        `\n__decoded["PUB"].uri = "${at("did:plc:eve", "site.standard.publication", "probe")}"`,
      read: PROJECT_STATE_URI,
    });
    expect(r.state.publication.uri).toBe(PUBLICATION_URI);
  });

  it("refuses a name longer than 5000 bytes or a description longer than 30000", () => {
    for (const value of [`name = string.rep("a", 5001),`, `description = string.rep("a", 30001),`]) {
      const r = job(PUBLICATION, PUBLICATION_INPUT, {
        setup: servePublication(publicationRecord("bafypub", value)),
        read: PROJECT_STATE_URI,
      });
      expect(writes(r.calls)).toHaveLength(0);
      expect(logs(r.calls).some((l) => l.level === "warn")).toBe(true);
    }
    const r = job(PUBLICATION, PUBLICATION_INPUT, {
      setup: servePublication(publicationRecord("bafypub", `name = string.rep("a", 5000), description = string.rep("a", 30000),`)),
      read: PROJECT_STATE_URI,
    });
    expect(r.state.publication.name).toHaveLength(5000);
  });

  it("finishes without writing when the publisher's PDS cannot be resolved", () => {
    // A retry moments later would not resolve it either.
    const r = job(PUBLICATION, PUBLICATION_INPUT, { setup: `package.loaded["happyview.atproto"] = { resolve_service_endpoint = function() return nil end }`, read: PROJECT_STATE_URI });
    expect(r.ok).toBe(true);
    expect(writes(r.calls)).toHaveLength(0);
    expect(logs(r.calls).some((l) => l.level === "warn")).toBe(true);
  });

  it("raises when the PDS cannot answer, so the job is retried", () => {
    const r = job(PUBLICATION, PUBLICATION_INPUT, { read: PROJECT_STATE_URI });
    expect(r.ok).toBe(false);
    expect(writes(r.calls)).toHaveLength(0);
  });
});

const documentRecord = (value: string) => `{
  uri = "${DOCUMENT_URI}", cid = "bafydoc",
  value = {
    ["$type"] = "site.standard.document",
    site = "${PUBLICATION_URI}",
    path = "/changelog/1.0.0",
    title = "Probe 1.0.0",
    publishedAt = "2026-10-23T00:00:00Z",
    ${value}
  },
}`;
const serveDocument = (body: string) =>
  `__pds["${recordUrl("site.standard.document", "3kchangelog")}"] = { status = 200, body = "DOC" }
__decoded["DOC"] = ${body}`;
const CHANGELOG_INPUT = `{ did = "${DID}", name = "probe", version = "1.0.0", uri = "${DOCUMENT_URI}" }`;
const fetchChangelog = (value: string, setup = "") =>
  job(CHANGELOG, CHANGELOG_INPUT, { setup: serveDocument(documentRecord(value)) + "\n" + setup, read: CHANGELOG_URI });

describe("registry.fetch-changelog", () => {
  it("raises without HAPPYPROTO_DID", () => {
    const r = job(CHANGELOG, CHANGELOG_INPUT, { ctx: "{ env = {} }", read: CHANGELOG_URI });
    expect(r.ok).toBe(false);
  });

  it("caches the markdown from at.markpub.markdown content", () => {
    const r = fetchChangelog(`textContent = "plain",
      content = { ["$type"] = "at.markpub.markdown", text = { ["$type"] = "at.markpub.text", markdown = "# Fixed" }, flavor = "commonmark" },`);
    expect(r.ok).toBe(true);
    expect(gets(r.calls)).toContain(recordUrl("site.standard.document", "3kchangelog"));
    expect(r.state.uri).toBe(DOCUMENT_URI);
    expect(r.state.title).toBe("Probe 1.0.0");
    expect(r.state.markdown).toBe("# Fixed");
    expect(r.state.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("falls back to textContent for other content", () => {
    const r = fetchChangelog(`textContent = "plain", content = { ["$type"] = "com.example.html", html = "<p>x</p>" },`);
    expect(r.state.markdown).toBe("plain");
  });

  it("falls back to textContent with no content", () => {
    const r = fetchChangelog(`textContent = "plain",`);
    expect(r.state.markdown).toBe("plain");
  });

  it("refuses a document of another publication", () => {
    const r = job(CHANGELOG, CHANGELOG_INPUT, {
      setup:
        serveDocument(documentRecord(`textContent = "plain",`)) +
        `\n__decoded["DOC"].value.site = "${at(DID, "site.standard.publication", "other")}"`,
      read: CHANGELOG_URI,
    });
    expect(writes(r.calls)).toHaveLength(0);
    expect(r.state).toBeNull();
  });

  it("refuses a document with no text", () => {
    const r = fetchChangelog(``);
    expect(writes(r.calls)).toHaveLength(0);
  });

  it("refuses a document in another repo without fetching it", () => {
    const r = job(CHANGELOG, `{ did = "${DID}", name = "probe", version = "1.0.0", uri = "${at("did:plc:eve", "site.standard.document", "3k")}" }`, {
      // Eve's PDS resolves, so only the repo check keeps it from being asked.
      setup: `package.loaded["happyview.atproto"] = { resolve_service_endpoint = function() return "${PDS}" end }`,
      read: CHANGELOG_URI,
    });
    expect(r.ok).toBe(true);
    expect(gets(r.calls)).toHaveLength(0);
    expect(writes(r.calls)).toHaveLength(0);
  });

  it("refuses a title longer than 5000 bytes", () => {
    const r = fetchChangelog(`textContent = "plain",`, `__decoded["DOC"].value.title = string.rep("a", 5001)`);
    expect(writes(r.calls)).toHaveLength(0);
    expect(logs(r.calls).some((l) => l.level === "warn")).toBe(true);
  });

  it("refuses markdown longer than 1 MiB", () => {
    const over = fetchChangelog(`textContent = string.rep("a", 1048577),`);
    expect(writes(over.calls)).toHaveLength(0);
    const at = fetchChangelog(`textContent = string.rep("a", 1048576),`);
    expect(at.state.markdown).toHaveLength(1048576);
  });

  it("finishes without writing when the publisher's PDS cannot be resolved", () => {
    const r = job(CHANGELOG, CHANGELOG_INPUT, { setup: `package.loaded["happyview.atproto"] = { resolve_service_endpoint = function() return nil end }`, read: CHANGELOG_URI });
    expect(r.ok).toBe(true);
    expect(writes(r.calls)).toHaveLength(0);
    expect(logs(r.calls).some((l) => l.level === "warn")).toBe(true);
  });

  it("raises when the PDS cannot answer, so the job is retried", () => {
    const r = job(CHANGELOG, CHANGELOG_INPUT, { read: CHANGELOG_URI });
    expect(r.ok).toBe(false);
  });
});
