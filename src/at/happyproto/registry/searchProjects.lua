-- @prelude registry, json
--
-- xrpc.query:at.happyproto.registry.searchProjects
--
-- Finds plugins. Retired projects are left out unless asked for.
--
-- Two paths. With `q`, display names and project names are matched and the
-- answer is capped at `limit`, with no cursor, since it merges two queries.
-- Without it every sidecar is paged, newest first. Filters run on the page,
-- so a filtered page can hold fewer than `limit` projects and still carry a
-- cursor.
--
-- Both matches are scoped so only plugins can fill the cap: display names
-- come from the registry's own state rows, and project names from sidecars,
-- which exist only for plugins. The index's ranked substring search can be
-- scoped to neither, so a stranger's rows could take every slot. A sidecar
-- whose project is not indexed is no plugin, so project_view answers nothing
-- for it on either path.

local db = require("happyview.db")

--- `q` as a LIKE pattern body that matches it and, where `q` holds one of
--- LIKE's own characters, possibly more. `%` and `_` are wildcards, and the
--- escape character is `\` on Postgres and absent on SQLite, while the
--- query builder writes no ESCAPE clause, so no escape works on both. Each
--- of the three becomes `_`, which matches that one character among others,
--- and `contains` drops what only the wildcard matched.
local function like_body(q)
  return (q:gsub("[%%_\\]", "_"))
end

--- Whether `text` contains `q` literally, ignoring ASCII case. Asked only
--- when `q` holds a LIKE character: otherwise the database's own match is
--- exact, and its case folding reaches past ASCII where Lua's does not.
local function contains(text, q)
  if not q:find("[%%_\\]") then return true end
  return type(text) == "string" and text:lower():find(q:lower(), 1, true) ~= nil
end

--- `(did, name)` pairs whose display name or project name contains `q`,
--- ignoring case, the display names first, each project once.
local function matches(our_did, q, limit)
  local found, seen = {}, {}
  local function add(did, name)
    local key = tostring(did) .. ":" .. tostring(name)
    if is_did(did) and is_project_name(name) and not seen[key] then
      seen[key] = true
      found[#found + 1] = { did = did, name = name }
    end
  end
  local body = like_body(q)
  local by_display = db.records(PROJECT_STATE):did(our_did)
    :where("publication.name", "ilike", "%" .. body .. "%"):limit(limit):run() or {}
  for _, e in ipairs(by_display.records or {}) do
    local r = e.record
    if type(r) == "table" and type(r.publication) == "table" and contains(r.publication.name, q) then
      add(r.did, r.name)
    end
  end
  -- A sidecar has no name field, but the project it must point at ends in
  -- the name, so `q` is matched against that key alone.
  local by_name = db.records(SIDECAR)
    :where("project", "ilike", "%/" .. PROJECT .. "/%" .. body .. "%"):limit(limit):run() or {}
  for _, e in ipairs(by_name.records or {}) do
    if contains(e.rkey, q) then add(e.did, e.rkey) end
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
