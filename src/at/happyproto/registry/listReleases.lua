-- @prelude registry, failure, json
--
-- xrpc.query:at.happyproto.registry.listReleases
--
-- Every release of a package, newest-indexed first, withdrawn ones included
-- and flagged. A client resolving an exact version has to be able to see that
-- the version exists at all, so filtering the deleted ones out here would
-- defeat the point of keeping them.

local db = require("happyview.db")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, slug = input.did, input.slug
  if not is_did(did) or not is_plugin_slug(slug) then
    return { releases = json.to_array({}) }
  end

  local limit, cursor = registry_page(input)
  local query = db.records(RELEASE_COLLECTION)
    :did(did)
    :where("package", "=", slug)
    :sort("indexed_at", "desc")
    :limit(limit)
  if cursor then query = query:cursor(cursor) end
  local page = query:run()

  local releases = {}
  for _, envelope in ipairs(page.records or {}) do
    local version = envelope.record and envelope.record.version
    local state = version and db.get("at://" .. our_did .. "/" .. RELEASE_STATE .. "/"
      .. release_state_rkey(did, slug, version)) or nil
    releases[#releases + 1] = release_view(envelope, state and state.record or nil)
  end

  return { releases = json.to_array(releases), cursor = page.cursor }
end
