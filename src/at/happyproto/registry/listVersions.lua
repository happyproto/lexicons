-- @prelude registry, json
--
-- xrpc.query:at.happyproto.registry.listVersions
--
-- A plugin's versions, most recently indexed first, whatever their state.
--
-- Changelogs are served as cached and never refreshed here: a page would
-- wait on one fetch per version, and an anonymous query has no caller to
-- enqueue a refresh job as. getVersion refreshes the one it answers.

local db = require("happyview.db")

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local did, name = input.did, input.name
  if not is_did(did) or not is_project_name(name) or not db.get(uri_of(did, SIDECAR, name)) then
    return failure("ProjectNotFound", "no project of that name is indexed for that publisher")
  end

  local limit, cursor = registry_page(input)
  local project_uri = uri_of(did, PROJECT, name)
  local query = db.records(VERSION):did(did):where("project", "=", project_uri)
    :sort("indexed_at", "desc"):limit(limit)
  if cursor then query = query:cursor(cursor) end
  local page = query:run() or {}

  local project_statuses = statuses_about(did, project_uri)
  local versions = {}
  for _, row in ipairs(page.records or {}) do
    local version_name, version = split_rkey(row.rkey)
    -- A row with no state was written through the gateway and not yet
    -- indexed; it is listed once the network echoes it.
    local view = version_name == name and is_release_version(version)
      and version_view(our_did, did, name, version, { project_statuses = project_statuses }) or nil
    if view then versions[#versions + 1] = view end
  end

  return { versions = json.to_array(versions), cursor = page.cursor }
end
