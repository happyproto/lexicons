-- @prelude release, authority
--
-- record.index:software.release.version
--
-- Indexes a version of a plugin project: `<name>.<version>`, naming its own
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

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local did, uri, r = input.did, input.uri, input.record
  local name, version = split_rkey(input.rkey)
  if not name or not is_release_version(version) then
    log.info("registry: version key is not <name>.<version>", { did = did, rkey = input.rkey })
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

  local problem = version_record_problem(our_did, did, name, version, r)
  if problem then
    log.info("registry: version refused", { uri = uri, reason = problem })
    return nil
  end

  index_version(our_did, did, uri, name, version, r)
  return true
end
