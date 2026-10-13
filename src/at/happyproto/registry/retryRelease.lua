-- at.happyproto.registry.retryRelease
--
-- Copy a pending release's artifact again. The indexer enqueues the copy once,
-- when it first sees a release, and a release is listed only once that copy
-- succeeds. Nothing enqueues it again, so a copy that failed -- an artifact
-- URL that was briefly down, a host that could not yet carry the bytes --
-- would leave the release pending for good. Its publisher retries it here.
--
-- Only a pending release has anything to retry: an active one is already
-- held and is answered as it is, and a withdrawn one is never copied.

-- @prelude registry, failure

local db = require("happyview.db")
local jobs = require("happyview.jobs")
local log = require("internal.logging")

local COPY_JOB = "registry.copy-artifact"

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then
    return failure("NotConfigured", "the registry has no identity configured")
  end

  local slug, version = input.slug, input.version
  if not is_plugin_slug(slug) then
    return failure("InvalidRequest", "slug is not a package slug")
  end
  if not is_plugin_version(version) then
    return failure("InvalidRequest", "version is not a semver version without build metadata")
  end

  local caller = ctx.caller_did
  if not caller then
    return failure(
      "AuthRequired",
      "your identity could not be determined, so there is no release of yours to retry"
    )
  end

  local uri = "at://" .. caller .. "/" .. RELEASE_COLLECTION .. "/" .. slug .. ":" .. version
  if not db.get(uri) then
    return failure("ReleaseNotFound", "that version is not published from your account")
  end

  local state_rkey = release_state_rkey(caller, slug, version)
  local state = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/" .. state_rkey)
  local status = state and state.record and state.record.status
  if not status then
    return failure(
      "ReleaseNotIndexed",
      "the registry has not indexed that release, so there is no copy to retry; it may have refused the record"
    )
  end
  if status == "deleted" then
    return failure("ReleaseNotFound", "that version was withdrawn")
  end
  if status ~= "pending" then
    return { uri = uri, status = status }
  end

  -- The same input the indexer enqueues with. The job skips a release that is
  -- active by the time it runs, so retrying twice copies once.
  local ok, err = pcall(jobs.create, COPY_JOB, {
    did = caller,
    slug = slug,
    version = version,
    uri = uri,
    stateRkey = state_rkey,
  })
  if not ok then
    log.warn("registry: retryRelease could not enqueue the copy", {
      did = caller, slug = slug, version = version, error = tostring(err),
    })
    return failure("Upstream", "the copy could not be enqueued")
  end

  return { uri = uri, status = "pending" }
end
