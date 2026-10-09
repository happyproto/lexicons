-- @prelude registry, failure, json
--
-- xrpc.query:at.happyproto.registry.searchPackages
--
-- Finds packages, never returning withdrawn ones.
--
-- Two paths, because the index's substring search takes no cursor and no
-- second filter: with `q` the answer is ranked by match and capped, and
-- without it the answer is paged. The response's `cursor` is optional for
-- exactly this reason. A Meilisearch-backed library would collapse the two
-- into one ranked, filtered, paged query; until then the capped list is the
-- honest behaviour rather than a cursor that silently loses rows.

local db = require("happyview.db")

--- Whether a package's latest release is of `want`. Reads the newest release
--- and its declared manifest; a package with no release matches nothing.
local function is_plugin_type(did, slug, want)
  local page = db.records(RELEASE_COLLECTION)
    :did(did)
    :where("package", "=", slug)
    :sort("indexed_at", "desc")
    :limit(1)
    :run()
  local newest = (page.records or {})[1]
  if not newest then return false end
  local ext = ((newest.record or {}).extensions or {})["at.happyproto.plugin.releaseExtension"]
  return type(ext) == "table" and ext.pluginType == want
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local limit, cursor = registry_page(input)
  local q = input.q
  local searching = type(q) == "string" and q ~= ""

  local envelopes, next_cursor
  if searching then
    envelopes = db.search(PROFILE_COLLECTION, "name", q, limit) or {}
  else
    local query = db.records(PROFILE_COLLECTION):sort("indexed_at", "desc"):limit(limit)
    if cursor then query = query:cursor(cursor) end
    local page = query:run()
    envelopes, next_cursor = page.records or {}, page.cursor
  end

  local packages = {}
  for _, envelope in ipairs(envelopes) do
    local did, slug = envelope.did, envelope.rkey
    local state = db.get("at://" .. our_did .. "/" .. PACKAGE_STATE .. "/" .. did .. ":" .. slug)
    local status = state and state.record.status or "unknown"
    -- A withdrawn package is never a search result; it stays readable by name.
    local wanted = status ~= "deleted"
      and (input.pluginType == nil or is_plugin_type(did, slug, input.pluginType))
    if wanted then
      packages[#packages + 1] = package_view(envelope, state and state.record or nil, nil)
    end
  end

  return { packages = json.to_array(packages), cursor = (not searching) and next_cursor or nil }
end
