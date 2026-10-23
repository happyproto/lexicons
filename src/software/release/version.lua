-- @prelude release, authority
--
-- record.index:software.release.version
--
-- Indexes a version of a plugin project: `<name>:<version>`, naming its own
-- project and pinning, by CID, a stored manifest of that same project in the
-- same repo. The CID is checked against the stored row, which is the only CID
-- the registry holds, so a version can only vouch for the manifest bytes the
-- registry itself indexed.
--
-- The publisher's record is stored verbatim; what the registry derives lives
-- in a VERSION_STATE row of ours. It starts `pending`, and only the copy job
-- moves it to `available`, so nothing is served before its bytes are held.
--
-- A version is immutable. A rewrite (an `update`, or a different `create` at a
-- stored key) keeps the first record and marks the version suspect. That
-- holds even for an update of a version never stored: an update is the
-- tampering signal, unlike a project's, which may legitimately add renamedTo.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")
local jobs = require("happyview.jobs")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local did, uri, r = input.did, input.uri, input.record
  local name, version = split_rkey(input.rkey)
  if not name or not is_release_version(version) then
    log.info("registry: version key is not <name>:<version>", { did = did, rkey = input.rkey })
    return nil
  end

  local state_rkey = version_state_rkey(did, name, version)
  local state = db.get(uri_of(our_did, VERSION_STATE, state_rkey))

  --- Merges `fields` into the existing state row, if there is one.
  local function mark(fields)
    if not state then return end
    local row = state.record or {}
    for k, v in pairs(fields) do row[k] = v end
    record.save_local(VERSION_STATE, state_rkey, row, our_did)
  end

  if input.action == "delete" then
    -- The row stays, so a version already installed keeps resolving by exact
    -- version; the state says the source is gone.
    mark({ availability = "deletedAtSource" })
    return nil
  end

  local stored = prior_row(uri, r)
  if input.action == "update" or (stored and not same_value(stored.record, r)) then
    log.warn("registry: version changed after publication; keeping the first", {
      did = did, name = name, version = version,
    })
    mark({ suspect = true })
    return nil
  end
  -- A create matching the stored row is a replayed cursor.
  if stored then return nil end

  if type(r) ~= "table" or r.version ~= version or r.project ~= uri_of(did, PROJECT, name) then
    log.info("registry: version does not match its key", { uri = uri })
    return nil
  end
  if not live_sidecar(our_did, did, name) then
    log.info("registry: version's project has no plugin sidecar", { uri = uri, name = name })
    return nil
  end

  local ref = r.manifest
  if type(ref) ~= "table" or type(ref.cid) ~= "string" then
    log.info("registry: version has no manifest reference", { uri = uri })
    return nil
  end
  local manifest_did, collection = parse_uri(ref.uri)
  local manifest = manifest_did == did and collection == MANIFEST and db.get(ref.uri) or nil
  if not manifest or manifest.cid ~= ref.cid or (manifest.record or {}).project ~= r.project then
    -- Arrival follows the repo's commit order, so a manifest not stored yet
    -- was itself skipped; it is not coming later.
    log.info("registry: version's manifest is not a stored manifest of its project", { uri = uri })
    return nil
  end

  -- What happened to the manifest before this version arrived still applies
  -- to it: a rewritten manifest makes it suspect, and a deleted one leaves
  -- nothing at the source to copy.
  local marks = project_state(our_did, did, name) or {}
  local rewritten = type(marks.suspectManifests) == "table" and marks.suspectManifests[ref.uri] == true
  local gone = type(marks.deletedManifests) == "table" and marks.deletedManifests[ref.uri] == true
  local previous = state and state.record or {}

  record.save_local(VERSION_STATE, state_rkey, {
    did = did,
    name = name,
    version = version,
    uri = uri,
    manifestUri = ref.uri,
    manifestCid = ref.cid,
    availability = gone and "deletedAtSource" or "pending",
    -- A suspect mark outlives a delete and a re-create: the key was rewritten.
    suspect = previous.suspect == true or rewritten,
    -- Bytes a copy job already holds stay held and servable by CID.
    held = previous.held,
  }, our_did)

  if not gone then
    jobs.create("registry.copy-version", { did = did, name = name, version = version })
  end

  -- Only a document in the publisher's own repo is cached: a changelog from
  -- elsewhere is not the publisher's statement about this release.
  local changelog_did, changelog_collection = parse_uri(r.changelog)
  if changelog_did == did and changelog_collection == DOCUMENT then
    jobs.create("registry.fetch-changelog", {
      did = did, name = name, version = version, uri = r.changelog,
    })
  end

  return true
end
