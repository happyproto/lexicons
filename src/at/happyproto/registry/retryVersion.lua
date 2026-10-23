-- at.happyproto.registry.retryVersion
--
-- Copy a version's blobs into the registry again after an earlier copy
-- failed. Only the registry's own account may ask: the copy runs as the
-- instance, against a publisher's PDS.

-- @prelude registry

local db = require("happyview.db")
local log = require("internal.logging")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local did, name, version = input.did, input.name, input.version
  if not is_did(did) or not is_project_name(name) or not is_release_version(version) then
    return failure("InvalidRecord", "did, name and version must name a version")
  end

  local caller = ctx.caller_did
  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined"
    )
  end
  if caller ~= our_did then
    return failure("Forbidden", "only the registry's own account may retry a copy")
  end

  local row = db.get(uri_of(our_did, VERSION_STATE, version_state_rkey(did, name, version)))
  local state = row and row.record
  if type(state) ~= "table" then
    return failure("VersionNotFound", "no version of that project is indexed at that version string")
  end

  -- An available version may still lack an image whose copy failed, and
  -- the job fetches only what it doesn't hold. One deleted at its source
  -- never becomes available, so there is nothing to retry.
  if state.availability ~= "deletedAtSource" then
    local jobs = require("happyview.jobs")
    local queued, err = pcall(jobs.create, "registry.copy-version", { did = did, name = name, version = version })
    if not queued then
      log.warn("registry: retryVersion could not enqueue the copy", {
        did = did, name = name, version = version, error = tostring(err),
      })
      return failure("Upstream", "the copy could not be enqueued; try again")
    end
  end

  return { availability = state.availability }
end
