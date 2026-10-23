-- @prelude release, authority
--
-- record.index:software.release.manifest
--
-- Indexes a manifest carrying exactly one valid HappyView plugin artifact, for
-- a project of the same repo that has a plugin sidecar. Nothing is copied
-- yet: a manifest no version names is not a release, and the version's index
-- script starts the copy.
--
-- A manifest is immutable. The event carries no CID, so a rewrite is
-- recognised by the event itself: an `update`, or a `create` at a stored key
-- with different content. Either keeps the first record and marks every
-- version built on it suspect, since what those versions vouch for has been
-- changed underneath them.

local log = require("internal.logging")
local db = require("happyview.db")
local record = require("happyview.record")

--- Rewrites every VERSION_STATE row whose manifest is `uri` with `fields`
--- merged in. A manifest can back several versions: a promotion stamps a new
--- version on the same manifest.
local function mark_versions(our_did, uri, fields)
  local cursor
  repeat
    local query = db.records(VERSION_STATE):did(our_did):where("manifestUri", "=", uri):limit(100)
    if cursor then query = query:cursor(cursor) end
    local page = query:run()
    local rows = page.records or {}
    for _, row in ipairs(rows) do
      local _, _, rkey = parse_uri(row.uri)
      if rkey then
        local state = row.record or {}
        for k, v in pairs(fields) do state[k] = v end
        record.save_local(VERSION_STATE, rkey, state, our_did)
      end
    end
    cursor = page.cursor
  until not cursor or #rows == 0
end

--- Records on the project's state that the manifest at `uri` was rewritten
--- or deleted (`field` is `suspectManifests` or `deletedManifests`), so a
--- version that arrives after this event still learns it. The project is the
--- one the stored manifest names; an unstored manifest backs no version.
local function mark_manifest(our_did, did, stored, uri, field)
  local project_did, collection, name = parse_uri(stored and (stored.record or {}).project)
  if project_did ~= did or collection ~= PROJECT or not is_project_name(name) then return end
  local state = project_state(our_did, did, name) or {}
  state[field] = state[field] or {}
  state[field][uri] = true
  save_project_state(our_did, did, name, state)
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    error("HAPPYPROTO_DID is unset or malformed, so registry state cannot be written")
  end

  local did, uri, r = input.did, input.uri, input.record

  local stored = db.get(uri)

  if input.action == "delete" then
    -- The row stays, so versions already copied keep resolving; the state says
    -- the source is gone.
    mark_versions(our_did, uri, { availability = "deletedAtSource" })
    mark_manifest(our_did, did, stored, uri, "deletedManifests")
    return nil
  end

  if input.action == "update" or (stored and not same_value(stored.record, r)) then
    log.warn("registry: manifest changed after publication; keeping the first", { uri = uri })
    mark_versions(our_did, uri, { suspect = true })
    mark_manifest(our_did, did, stored, uri, "suspectManifests")
    return nil
  end
  -- A create matching the stored row is a replayed cursor.
  if stored then return nil end

  if type(r) ~= "table" then return nil end
  local project_did, collection, name = parse_uri(r.project)
  if project_did ~= did or collection ~= PROJECT or not is_project_name(name) then
    log.info("registry: manifest names no project of its own repo", { uri = uri })
    return nil
  end
  local sidecar = live_sidecar(our_did, did, name)
  if not sidecar then
    log.info("registry: manifest's project has no plugin sidecar", { uri = uri, name = name })
    return nil
  end
  if not db.get(r.project) then
    log.info("registry: manifest's project is not indexed", { uri = uri, name = name })
    return nil
  end

  local artifact, problem = manifest_artifact(r)
  problem = problem or artifact_problem(artifact)
  if not problem and artifact.pluginType ~= (sidecar.record or {}).pluginType then
    problem = "pluginType is not the one the sidecar declares"
  end
  if problem then
    log.info("registry: manifest refused", { uri = uri, reason = problem })
    return nil
  end
  return true
end
