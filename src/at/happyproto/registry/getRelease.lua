-- @prelude registry, failure
--
-- xrpc.query:at.happyproto.registry.getRelease
--
-- One release by exact version, served whatever its status. A withdrawn
-- version is still answered: an instance that already depends on it must be
-- able to resolve it, which is the left-pad protection the registry exists
-- for.

local db = require("happyview.db")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, slug, version = input.did, input.slug, input.version
  if not is_did(did) or not is_plugin_slug(slug) or not is_plugin_version(version) then
    return failure("ReleaseNotFound", "no release is indexed at that version")
  end

  local release = db.get("at://" .. did .. "/" .. RELEASE_COLLECTION .. "/" .. slug .. ":" .. version)
  if not release then
    return failure("ReleaseNotFound", "no release is indexed at that version")
  end

  local state = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/"
    .. release_state_rkey(did, slug, version))
  return release_view(release, state and state.record or nil)
end
