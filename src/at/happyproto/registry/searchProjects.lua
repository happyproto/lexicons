-- @prelude registry, json
--
-- xrpc.query:at.happyproto.registry.searchProjects
--
-- Finds plugins. Retired projects are left out unless asked for.
--
-- Two paths, because the index's substring search takes no cursor: with `q`
-- the answer is ranked by match and capped at `limit`, with no cursor, and
-- without it every sidecar is paged, newest first. Filters run on the page,
-- so a filtered page can hold fewer than `limit` projects and still carry a
-- cursor.

local db = require("happyview.db")

--- `(did, name)` pairs whose display name or project name matches `q`, the
--- display names first, each project once.
local function matches(our_did, q, limit)
  local found, seen = {}, {}
  local function add(did, name)
    local key = tostring(did) .. ":" .. tostring(name)
    if is_did(did) and is_project_name(name) and not seen[key] then
      seen[key] = true
      found[#found + 1] = { did = did, name = name }
    end
  end
  for _, e in ipairs(db.search(PROJECT_STATE, "publication.name", q, limit) or {}) do
    -- Only the registry's own state: a row under any other DID is not ours.
    if e.did == our_did and type(e.record) == "table" then add(e.record.did, e.record.name) end
  end
  for _, e in ipairs(db.search(PROJECT, "name", q, limit) or {}) do
    add(e.did, e.rkey)
  end
  return found
end

function handle(input, ctx)
  local our_did = happyproto_did(ctx)
  if not our_did then return failure("NotConfigured", "the registry has no identity configured") end

  local limit, cursor = registry_page(input)
  -- Query parameters can arrive as text.
  local include_retired = input.includeRetired == true or input.includeRetired == "true"
  local plugin_type = type(input.pluginType) == "string" and input.pluginType ~= "" and input.pluginType or nil
  local q = input.q
  local searching = type(q) == "string" and q ~= ""

  local candidates, next_cursor = {}, nil
  if searching then
    candidates = matches(our_did, q, limit)
  else
    local query = db.records(SIDECAR):sort("indexed_at", "desc"):limit(limit)
    if plugin_type then query = query:where("pluginType", "=", plugin_type) end
    if cursor then query = query:cursor(cursor) end
    local page = query:run() or {}
    for _, e in ipairs(page.records or {}) do
      candidates[#candidates + 1] = { did = e.did, name = e.rkey }
    end
    next_cursor = page.cursor
  end

  local handles = {}
  local projects = {}
  for _, c in ipairs(candidates) do
    if handles[c.did] == nil then handles[c.did] = handle_for(c.did) or false end
    local view = is_did(c.did) and is_project_name(c.name)
      and project_view(our_did, c.did, c.name, handles[c.did]) or nil
    local wanted = view
      and (plugin_type == nil or view.pluginType == plugin_type)
      and (include_retired or view.lifecycle.state ~= "retired")
    if wanted and #projects < limit then projects[#projects + 1] = view end
  end

  return { projects = json.to_array(projects), cursor = next_cursor }
end
