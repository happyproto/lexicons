-- @prelude registry, failure
--
-- xrpc.query:at.happyproto.registry.getPackage
--
-- One package, with its highest active version. A withdrawn package is still
-- answered, flagged `deleted`, because its releases stay resolvable by exact
-- version.
--
-- `actor` is a DID or a handle. A handle is resolved through
-- happyview.atproto, which confirms it in both directions, so a handle
-- pointed at someone else's DID cannot show their packages under it. The
-- resolved handle is echoed on the view; a DID answers with it resolved too,
-- so the response does not depend on how the package was asked for.

local db = require("happyview.db")

--- The highest `active` version among a package's releases, or nil. Computed
--- here rather than ordered by the index, because semver precedence is not a
--- lexicographic sort: 3.10.0 outranks 3.9.0, and 3.0.0 outranks 3.0.0-rc.1.
local function latest_active(our_did, did, slug)
  local page = db.records(RELEASE_COLLECTION)
    :did(did)
    :where("package", "=", slug)
    :limit(100)
    :run()

  local latest
  for _, envelope in ipairs(page.records or {}) do
    local version = envelope.record and envelope.record.version
    if version and is_plugin_version(version) then
      local state = db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/"
        .. release_state_rkey(did, slug, version))
      if state and state.record.status == "active" then
        if not latest or plugin_version_lt(latest, version) then latest = version end
      end
    end
  end
  return latest
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local actor, slug = input.actor, input.slug
  local did, handle = resolve_actor(actor)
  if not did then
    return failure("ActorNotFound", "that publisher could not be resolved")
  end
  if not is_plugin_slug(slug) then
    return failure("PackageNotFound", "no package is indexed for that publisher and slug")
  end

  local profile = db.get("at://" .. did .. "/" .. PROFILE_COLLECTION .. "/" .. slug)
  if not profile then
    return failure("PackageNotFound", "no package is indexed for that publisher and slug")
  end

  -- Asked for by DID, the handle still belongs on the view, so it is resolved
  -- for display. Best-effort: a publisher whose handle no longer resolves
  -- still has a readable package.
  handle = handle or handle_for(did)

  local state = db.get("at://" .. our_did .. "/" .. PACKAGE_STATE .. "/" .. did .. ":" .. slug)
  return package_view(
    profile,
    state and state.record or nil,
    latest_active(our_did, did, slug),
    handle
  )
end
