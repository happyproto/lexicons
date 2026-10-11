-- at.happyproto.registry.withdrawRelease
--
-- Delete a release record the caller published.
--
-- This is how a publisher withdraws a release, rather than calling
-- com.atproto.repo.deleteRecord through HappyView: HappyView proxies a method
-- it does not host to wherever the instance's routing points, which is not
-- necessarily the caller's PDS. `happyview.record` always deletes from the
-- caller's own repo, as them. The indexer sees the deletion on the firehose
-- like any other and tombstones the version.

-- @prelude registry, failure

local db = require("happyview.db")
local record = require("happyview.record")
local log = require("internal.logging")

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
      "your identity could not be determined, so there is no repo to delete from"
    )
  end

  local rkey = slug .. ":" .. version
  local uri = "at://" .. caller .. "/" .. RELEASE_COLLECTION .. "/" .. rkey
  local release = db.get(uri)
  if not release then
    return failure("ReleaseNotFound", "that version is not published from your account")
  end
  -- Still indexed after a withdraw (below), so the tombstone is what says so.
  local state = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/"
    .. release_state_rkey(caller, slug, version))
  if state and state.record and state.record.status == "deleted" then
    return failure("ReleaseNotFound", "that version was already withdrawn")
  end

  local deleted, err = pcall(record.delete, uri)
  if not deleted then
    -- The reason can name the caller's session or their PDS, so it is logged
    -- rather than returned.
    log.warn("registry: withdrawRelease could not delete", {
      did = caller, slug = slug, version = version, error = tostring(err),
    })
    return failure("Upstream", "the record could not be deleted from your repo")
  end

  -- A withdrawn release stays indexed, so it is still served by exact version
  -- and reads as withdrawn: the indexer skips the delete and only tombstones
  -- its state row. But `record.delete` drops the row from this instance's
  -- index as soon as the PDS accepts the delete, before the firehose brings
  -- the indexer anything, so it is put straight back. The delete has happened
  -- either way, so a failure here is logged, not returned.
  local restored, restore_err = pcall(record.save_local, RELEASE_COLLECTION, rkey, release.record)
  if not restored then
    log.warn("registry: withdrawRelease could not keep the release indexed", {
      did = caller, slug = slug, version = version, error = tostring(restore_err),
    })
  end

  return { uri = uri }
end
